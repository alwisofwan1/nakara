import { pickSecrets } from "../secrets.ts";
import { constants, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "../config.ts";
import { policyState, type Store, type WorkItem } from "../db.ts";
import {
  type Definition,
  factoryRepositories,
  hasSpecAgent,
} from "../definition/load.ts";
import { runsUsed } from "../domain/policy.ts";
import { runTurn } from "../harness/claude.ts";
import type { RecordedAction, TurnSnapshot } from "../mcp/types.ts";
import {
  agentCredentials,
  runLabels,
  type DockerSpec,
} from "../runner/docker.ts";
import {
  dockerSpec,
  prepareWorkspace,
  type Workspace,
  writeInternal,
} from "../runner/workspace.ts";
import { quietTelemetry, type Telemetry } from "../telemetry/metrics.ts";
import { foremanSystemPrompt, renderEvent, renderState } from "./prompts.ts";
import { policyFor } from "./pull-request-gate.ts";
import { queueReflect } from "./reflect.ts";
import {
  ended,
  harnessBins,
  NEVER,
  type RunControl,
  reachedBudget,
  recordRunEnd,
  reportStopped,
  resolveMcp,
  runLimitPause,
  SHUT_DOWN,
  STOPPED,
} from "./run-support.ts";

const MCP_SERVER = fileURLToPath(
  new URL("../mcp/factoryMcp.ts", import.meta.url),
);
const FOREMAN_IDLE_MS = 15 * 60_000;
/** Nakara's own code, which the `nakara` MCP server needs inside the container. */
const NAKARA_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MCP_CODE = ["src", "node_modules", "package.json"]
  .map((p) => join(NAKARA_ROOT, p))
  .filter((p) => existsSync(p));

/** The operator accepts a foreman that runs on the host, unsandboxed (ADR 0003). */
export const hostForemanAllowed = () =>
  process.env.NAKARA_ALLOW_HOST_FOREMAN === "1";

const FOREMAN_TOOLS = [
  "mcp__nakara",
  "Read",
  "Grep",
  "Glob",
  "Bash(gh issue view:*)",
  "Bash(gh issue list:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr checks:*)",
  "Bash(gh pr list:*)",
];

/** A foreman's container: what it may see, its credentials, and whether its home is new. */
interface Sandbox {
  docker: DockerSpec;
  env: Record<string, string>;
  fresh: boolean;
}

/** A foreman turn that ran: the actions it recorded, for the Factory to apply. */
export interface ForemanTurn {
  /** The events the turn handled; processed once its actions are applied. */
  eventIds: number[];
  /** Actions recorded before a failure are still the foreman's decisions. */
  recorded: RecordedAction[];
  /** Why the turn failed, unless it succeeded or was stopped. */
  failure: string | undefined;
}

/** Runs one foreman turn: from building its prompt and state to the actions it recorded. */
export class ForemanRunner {
  private readonly store: Store;
  private readonly config: Config;
  private readonly control: RunControl;
  /** The applied definition; throws when none is loaded. */
  private readonly definition: () => Definition;
  /** Pause the work item with a reason for the operator. */
  private readonly pause: (item: WorkItem, reason: string) => void;
  /** The factory's slug, which picks the agent token the foreman falls back to. */
  private readonly slug: string | undefined;
  private readonly telemetry: Telemetry;

  constructor(
    store: Store,
    config: Config,
    control: RunControl,
    hooks: {
      definition: () => Definition;
      pause: (item: WorkItem, reason: string) => void;
      slug?: string | undefined;
    },
    telemetry: Telemetry = quietTelemetry(),
  ) {
    this.store = store;
    this.config = config;
    this.control = control;
    this.definition = hooks.definition;
    this.pause = hooks.pause;
    this.slug = hooks.slug;
    this.telemetry = telemetry;
  }

  /**
   * The container a turn runs in, or undefined when the foreman's runner has no
   * image. Clones and the definition are read-only; only `turnDir` is writable,
   * and the container's home is the foreman's own, so what an agent left in its
   * home cannot reach the foreman's settings.
   */
  private async sandbox(
    def: Definition,
    ws: Workspace,
    turnDir: string,
  ): Promise<Sandbox | undefined> {
    const spec = await dockerSpec(def, def.foreman.runner, ws);
    if (!spec) return undefined;
    const home = join(ws.internal, "foreman-home");
    const fresh = !existsSync(home);
    await mkdir(home, { recursive: true });
    return {
      docker: {
        ...spec,
        mounts: [turnDir],
        readOnly: [ws.root, ...(spec.readOnly ?? []), ...MCP_CODE],
        home,
      },
      env: await agentCredentials(
        def.foreman.harness.kind,
        "foreman",
        this.slug,
      ),
      fresh,
    };
  }

  /** Run the turn; undefined when it ran no harness or was interrupted, its events then settled or still pending. */
  async run(itemId: number): Promise<ForemanTurn | undefined> {
    const def = this.definition();
    const item = this.store.item(itemId);
    const events = this.store.pendingEvents(itemId);
    if (!item || events.length === 0) return;
    const eventIds = events.map((e) => e.id);
    // Before the complete check: a PR closed without merge is a correction too.
    try {
      queueReflect(this.store, def, item, events);
    } catch (error) {
      this.telemetry.log
        .child({ item_id: itemId })
        .error("reflect.queue_failed", { error });
    }
    if (item.stage === "complete" || item.stage === "cancelled") {
      this.store.markEventsProcessed(eventIds);
      return;
    }
    const itemLog = this.telemetry.log.child({
      item_id: itemId,
      agent: def.foreman.name,
    });

    // A foreman turn is a run too: at the limit it does not start.
    if (runsUsed(policyState(item))) {
      this.store.markEventsProcessed(eventIds);
      itemLog.warn("item.run_limit", { runs: item.run_count });
      this.pause(item, runLimitPause(item));
      this.store.needsYou({
        itemId,
        event: "paused",
        what: runLimitPause(item),
      });
      return;
    }

    let ws: Workspace;
    try {
      ws = await prepareWorkspace(
        def,
        itemId,
        this.config,
        item.repo,
        this.config.claudeBin,
      );
    } catch (error) {
      itemLog.error("workspace.prepare_failed", { error });
      this.store.markEventsProcessed(eventIds);
      this.pause(
        item,
        `Could not prepare the workspace: ${String(error).slice(0, 1500)}`,
      );
      return;
    }

    let secrets: Record<string, string>;
    try {
      secrets = await pickSecrets(this.config.secretsPath, def.foreman.secrets);
    } catch (error) {
      this.store.markEventsProcessed(eventIds);
      this.pause(
        item,
        `Could not read the foreman's secrets: ${(error as Error).message}`,
      );
      return;
    }
    for (const value of Object.values(secrets)) itemLog.addSecret(value);

    const turnNo = item.foreman_turns + 1;
    const base = join(ws.internal, `foreman-${turnNo}`);
    // The one directory the container may write: its recorded actions.
    const turnDir = `${base}.turn`;
    await mkdir(turnDir, { recursive: true });
    const systemPromptFile = `${base}.system.md`;
    const statePath = join(turnDir, "state.json");
    const actionsPath = join(turnDir, "actions.jsonl");

    let sandbox: Sandbox | undefined;
    try {
      sandbox = await this.sandbox(def, ws, turnDir);
      if (!sandbox && !hostForemanAllowed())
        throw new Error(
          `the foreman's runner has no dockerImage, so it has no sandbox`,
        );
    } catch (error) {
      if (!hostForemanAllowed()) {
        itemLog.error("foreman.sandbox_unavailable", { error });
        this.store.markEventsProcessed(eventIds);
        this.pause(
          item,
          `The foreman runs in a sandbox container and none is available: ${String(error instanceof Error ? error.message : error).slice(0, 1500)}. Fix the runner, or set NAKARA_ALLOW_HOST_FOREMAN=1 to run the foreman on the host, unsandboxed.`,
        );
        return;
      }
      itemLog.warn("foreman.host_run", { error });
    }
    const runs = this.store.runs(itemId);
    const snapshot: TurnSnapshot = {
      foreman: def.foreman.name,
      // This turn's own run is counted when it starts, below.
      policy: {
        ...policyFor(this.store, item),
        runCount: item.run_count + 1,
        specAgent: hasSpecAgent(def),
      },
      repositories: factoryRepositories(def),
      agents: [...def.agents.values()]
        .filter((a) => a.type !== "FOREMAN")
        .map((a) => ({
          name: a.name,
          type: a.type,
          description: a.description,
          spawnableBy: a.spawnableBy,
        })),
      agentsWithSessions: [
        ...new Set(
          runs
            .filter((r) => r.role === "agent" && r.session_id)
            .map((r) => r.agent),
        ),
      ],
    };
    await writeInternal(
      systemPromptFile,
      foremanSystemPrompt(def, ws, snapshot.policy) + def.foreman.instructions,
    );
    await writeInternal(statePath, JSON.stringify(snapshot));
    await writeInternal(actionsPath, "");

    const prompt = [
      ...events.map((e) => renderEvent(e, item, def)),
      renderState(item, runs),
    ].join("\n\n");
    // Shutting down: the events stay pending for the turn after the restart.
    if (this.control.interrupting) return;
    const run = this.store.createRun({
      item_id: itemId,
      role: "foreman",
      agent: def.foreman.name,
      agent_type: "FOREMAN",
      harness: def.foreman.harness.kind,
      model: def.foreman.harness.model ?? null,
      session_id: item.foreman_session,
      status: "running",
      input: prompt,
    });
    const logPath = join(ws.internal, "logs", `run-${run.id}.jsonl`);
    this.store.markRunStarted(run.id, logPath);
    const startedAt = Date.now();
    // A turn waits from its oldest pending event.
    const waited =
      Math.max(0, startedAt - Date.parse(events[0]?.created_at ?? "")) / 1000;
    const log = itemLog.child({ run_id: run.id });
    this.telemetry.metrics.runWait.observe({ role: "foreman" }, waited);
    log.info("run.started", {
      harness: run.harness,
      wait_s: waited,
      events: events.map((e) => e.kind),
    });
    const controller = new AbortController();
    this.control.controllers.set(run.id, controller);

    const outcome = await runTurn(
      {
        harness: def.foreman.harness.kind,
        model: def.foreman.harness.model,
        effort: def.foreman.harness.effort,
        cwd: ws.root,
        prompt,
        systemPromptFile,
        // A fresh container home has none of the sessions a host run left behind.
        resumeSession: sandbox?.fresh
          ? undefined
          : (item.foreman_session ?? undefined),
        onTool: (tool) => {
          log.info("tool.called", { tool });
          this.store.countRunTool(run.id, tool);
        },
        mcpConfig: {
          ...resolveMcp(def.foreman.mcpServers, secrets),
          nakara: {
            command: sandbox ? "node" : process.execPath,
            args: [MCP_SERVER],
            env: { NAKARA_STATE: statePath, NAKARA_ACTIONS: actionsPath },
          },
        },
        mcpConfigPath: `${base}.mcp.json`,
        codexSessions: join(ws.internal, "codex-sessions"),
        permissionMode: "dontAsk",
        allowedTools: [
          ...FOREMAN_TOOLS,
          // Each server's own tools list, never the whole server.
          ...Object.entries(def.foreman.mcpServers).flatMap(([n, s]) =>
            "tools" in s ? (s.tools ?? []).map((t) => `mcp__${n}__${t}`) : [],
          ),
        ],
        disallowedTools: NEVER,
        maxBudgetUsd: item.budget_usd - item.cost_usd,
        idleTimeoutMs: FOREMAN_IDLE_MS,
        logPath,
        ...(sandbox && {
          env: sandbox.env,
          docker: {
            ...sandbox.docker,
            labels: runLabels(run.id, this.config.dataDir),
          },
        }),
        signal: controller.signal,
      },
      harnessBins(this.config),
    );
    this.control.controllers.delete(run.id);
    const stopped = this.control.stopped.delete(run.id) && !outcome.ok;
    // biome-ignore lint/style/noNonNullAssertion: Work items are never deleted.
    const spentBefore = this.store.item(itemId)!.cost_usd;
    // A turn that finished as the drain ran out is not interrupted.
    if (
      this.control.interrupting &&
      controller.signal.aborted &&
      !outcome.ok &&
      !stopped
    ) {
      // Its actions are not applied and its events stay pending: the turn
      // after the restart handles them again.
      const { status, error } = this.store.transaction(() =>
        this.store.interruptRun(run.id, ended(outcome), SHUT_DOWN),
      );
      recordRunEnd(this.telemetry, log, run, {
        status,
        startedAt,
        costUsd: outcome.costUsd,
        reachedBudget: reachedBudget(this.store, itemId, spentBefore),
        error,
      });
      return;
    }

    const status = outcome.ok
      ? "succeeded"
      : controller.signal.aborted
        ? "cancelled"
        : "failed";
    this.store.finishRun(run.id, {
      status,
      result: outcome.result,
      error: stopped ? STOPPED : outcome.error,
      cost_usd: outcome.costUsd,
      num_turns: outcome.numTurns,
      duration_ms: outcome.durationMs,
      session_id: outcome.sessionId,
      log_path: logPath,
    });
    this.store.addCost(itemId, outcome.costUsd);
    this.store.updateItem(itemId, {
      foreman_turns: turnNo,
      foreman_session: outcome.sessionId ?? item.foreman_session,
    });
    if (stopped) reportStopped(this.store, run);
    recordRunEnd(this.telemetry, log, run, {
      status,
      stopped,
      startedAt,
      costUsd: outcome.costUsd,
      reachedBudget: reachedBudget(this.store, itemId, spentBefore),
      error: outcome.error,
    });

    return {
      eventIds,
      recorded: await readActions(actionsPath),
      failure:
        !outcome.ok && !controller.signal.aborted
          ? (outcome.error ?? "unknown error")
          : undefined,
    };
  }
}

async function readActions(path: string): Promise<RecordedAction[]> {
  // Written by the container: a symlink in its place is never followed.
  const text = await readFile(path, {
    encoding: "utf8",
    flag: constants.O_RDONLY | constants.O_NOFOLLOW,
  }).catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RecordedAction];
      } catch {
        return [];
      }
    });
}
