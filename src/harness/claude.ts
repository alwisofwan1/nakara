// Runs one turn of a coding agent headless and reports the outcome.
// claude: Claude Code (`claude -p`). qwen: the same CLI behind
// NAKARA_QWEN_BIN (a wrapper that pins the gateway and model).
// codex: `codex exec --json`, logged in under its own CODEX_HOME.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type { HarnessKind } from "../definition/load.ts";
import {
  dockerize,
  nativeCodex,
  removeContainer,
  type DockerSpec,
} from "../runner/docker.ts";
import { hostEnv } from "../runner/env.ts";
import { openCodexHome } from "./codex-home.ts";
import { EgressWatch } from "./egress-watch.ts";
import { StreamCost } from "./pricing.ts";
import { openInternal, writeInternal } from "../runner/workspace.ts";

/** How long a stopped harness gets to exit on SIGTERM before it is killed. */
export const KILL_GRACE_MS = 5_000;

export interface TurnRequest {
  harness: HarnessKind;
  model: string | undefined;
  /** The CLI's effort (reasoning) level; undefined keeps its default. */
  effort?: string | undefined;
  cwd: string;
  prompt: string;
  systemPromptFile: string;
  /** Continue an existing conversation (follow-ups keep their context). */
  resumeSession?: string | undefined;
  /** Where the item's codex sessions are kept between its runs, outside every agent mount. */
  codexSessions?: string | undefined;
  mcpConfig?: Record<string, unknown> | undefined;
  mcpConfigPath?: string | undefined;
  allowedTools?: string[] | undefined;
  disallowedTools?: string[] | undefined;
  /** "bypassPermissions" for agents working in a workspace, "dontAsk" for the allowlisted foreman. */
  permissionMode: "bypassPermissions" | "dontAsk";
  maxBudgetUsd?: number | undefined;
  idleTimeoutMs: number;
  logPath: string;
  env?: NodeJS.ProcessEnv | undefined;
  /** Run inside a container instead of on the host; `env` then holds everything it gets. */
  docker?: DockerSpec | undefined;
  signal?: AbortSignal | undefined;
  /** Called once when the harness reports its session, before the turn ends. */
  onSession?: ((sessionId: string) => void) | undefined;
  /** Called for each external MCP tool call (mcp__<server>__<tool>); never for Nakara's own. */
  onTool?: ((tool: string) => void) | undefined;
}

export interface TurnOutcome {
  ok: boolean;
  sessionId: string | null;
  result: string | null;
  error: string | null;
  costUsd: number;
  numTurns: number | null;
  durationMs: number;
}

export interface Binaries {
  claude: string;
  qwen: string;
  codex: string;
  /** The operator's CODEX_HOME for factory runs, apart from ~/.codex; each run gets a copy of its login. */
  codexHome: string;
}

interface Command {
  bin: string;
  args: string[];
  env: Record<string, string>;
}

async function claudeCommand(
  req: TurnRequest,
  bins: Binaries,
): Promise<Command> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt-file",
    req.systemPromptFile,
  ];
  if (req.harness === "claude" && req.model) args.push("--model", req.model);
  if (req.harness === "claude" && req.effort) args.push("--effort", req.effort);
  if (req.resumeSession) args.push("--resume", req.resumeSession);
  if (req.mcpConfig && req.mcpConfigPath) {
    await writeInternal(
      req.mcpConfigPath,
      JSON.stringify({ mcpServers: req.mcpConfig }, null, 2),
      0o600,
    );
    args.push("--mcp-config", req.mcpConfigPath);
  }
  // Never inherit the operator's personal MCP servers into factory runs.
  args.push("--strict-mcp-config", "--permission-mode", req.permissionMode);
  if (req.allowedTools?.length)
    args.push("--allowedTools", ...req.allowedTools);
  if (req.disallowedTools?.length)
    args.push("--disallowedTools", ...req.disallowedTools);
  if (req.maxBudgetUsd !== undefined && req.harness === "claude")
    args.push("--max-budget-usd", Math.max(req.maxBudgetUsd, 0.01).toFixed(2));
  return {
    bin: req.harness === "qwen" ? bins.qwen : bins.claude,
    args,
    env: {},
  };
}

async function codexCommand(
  req: TurnRequest,
  bins: Binaries,
): Promise<Command> {
  const instructions = await readFile(req.systemPromptFile, "utf8");
  // A JSON string is a valid TOML basic string, which is how -c parses values.
  const args = [
    "exec",
    ...(req.resumeSession ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
  ];
  args.push("-c", `developer_instructions=${JSON.stringify(instructions)}`);
  if (req.model) args.push("-m", req.model);
  if (req.effort)
    args.push("-c", `model_reasoning_effort=${JSON.stringify(req.effort)}`);
  if (req.docker)
    args.push("--dangerously-bypass-approvals-and-sandbox"); // the container is the sandbox
  else
    args.push(
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      "sandbox_workspace_write.network_access=true",
    );
  if (req.resumeSession) args.push(req.resumeSession);
  args.push("-");
  return {
    bin: nativeCodex(bins.codex),
    args,
    env: { CODEX_HOME: bins.codexHome },
  };
}

export async function runTurn(
  req: TurnRequest,
  bins: Binaries,
): Promise<TurnOutcome> {
  if (req.harness !== "codex") return turn(req, bins);
  const home = await openCodexHome(
    bins.codexHome,
    req.codexSessions,
    req.resumeSession,
  );
  try {
    // The login link points outside the home; a container sees it at the same path.
    const docker = req.docker && {
      ...req.docker,
      mounts: [...req.docker.mounts, ...(home.login ? [home.login] : [])],
    };
    return await turn({ ...req, docker }, { ...bins, codexHome: home.path });
  } finally {
    await home.close();
  }
}

async function turn(req: TurnRequest, bins: Binaries): Promise<TurnOutcome> {
  const codex = req.harness === "codex";
  const { bin, args, env } = codex
    ? await codexCommand(req, bins)
    : await claudeCommand(req, bins);

  const started = Date.now();
  // Stopped before it started: never spawn, so no container can outlive the stop.
  if (req.signal?.aborted) return failed("Cancelled.", 0);
  const log = (await openInternal(req.logPath)).createWriteStream();
  const container = req.docker ? `nakara-${randomUUID()}` : undefined;
  const command = req.docker
    ? dockerize(
        {
          ...req.docker,
          name: container,
          mounts: [...req.docker.mounts, ...(codex ? [bins.codexHome] : [])],
          // qwen's wrapper and codex's vendor directory (helper binaries sit beside codex) keep their host paths.
          // The run's own prompt and MCP config are the only internal files it sees, read-only.
          readOnly: [
            ...(req.docker.readOnly ?? []),
            ...(codex ? [] : [req.systemPromptFile]),
            ...(!codex && req.mcpConfig && req.mcpConfigPath
              ? [req.mcpConfigPath]
              : []),
            ...(req.harness === "qwen"
              ? [bin]
              : codex
                ? [dirname(dirname(bin))]
                : []),
          ],
        },
        bins.claude,
        req.cwd,
        [req.harness === "claude" ? "claude" : bin, ...args],
        { ...req.env, ...env } as Record<string, string>,
      )
    : { cmd: bin, args, env: { ...hostEnv(req.harness), ...req.env, ...env } };
  const child = spawn(command.cmd, command.args, {
    cwd: req.cwd,
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const signal = (name: NodeJS.Signals) => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, name);
      } catch {
        child.kill(name);
      }
    }
  };
  // Signals to the docker CLI do not reliably reach the container, so it is removed by name.
  let killed = false;
  let forceKill: NodeJS.Timeout | undefined;
  const kill = () => {
    if (killed) return;
    killed = true;
    if (container) void removeContainer(container);
    signal("SIGTERM");
    forceKill = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
  };

  let idle: NodeJS.Timeout | undefined;
  let idleFired = false;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idleFired = true;
      kill();
    }, req.idleTimeoutMs);
  };
  touch();
  req.signal?.addEventListener("abort", kill, { once: true });
  // A model host the egress proxy refuses ends the run instead of retrying until the idle timeout.
  const egress = new EgressWatch(req.harness, req.docker?.egress?.allow, kill);

  let final: Record<string, unknown> | undefined;
  let lastAssistantText: string | null = null;
  let initSession: string | null = null;
  let stderrTail = "";
  /** The unfinished last line of stderr, so a refusal split across chunks is still seen. */
  let stderrLine = "";
  child.stderr.on("data", (chunk: Buffer) => {
    touch();
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    const lines = (stderrLine + chunk.toString()).split("\n");
    stderrLine = lines.pop() ?? "";
    for (const line of lines) egress.line(line);
    log.write(chunk);
  });
  // What the stream's usage cost, for a claude run that ends without its total.
  const streamed = new StreamCost();
  const seenTools = new Set<string>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    touch();
    log.write(`${line}\n`);
    const knownSession = initSession;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (codex) {
        if (
          event.type === "thread.started" &&
          typeof event.thread_id === "string"
        )
          initSession ??= event.thread_id;
        const item = event.item as { type?: string; text?: string } | undefined;
        if (event.type === "item.completed" && item?.type === "agent_message")
          lastAssistantText = item.text ?? lastAssistantText;
        if (event.type === "turn.completed" || event.type === "turn.failed")
          final = event;
        if (event.type === "error") egress.line(String(event.message ?? ""));
        else if (String(event.type).startsWith("item.")) egress.progress();
      } else {
        if (event.type === "result") final = event;
        if (event.type === "system" && typeof event.session_id === "string")
          initSession ??= event.session_id;
        if (event.type === "assistant") {
          lastAssistantText = assistantText(event) ?? lastAssistantText;
          streamed.add(event);
          egress.progress();
        }
        if (event.type === "system") egress.line(line);
      }
    } catch {
      // Non-JSON output (e.g. wrapper scripts) is kept in the log only.
    }
    if (!knownSession && initSession) req.onSession?.(initSession);
    if (req.onTool) for (const t of toolCalls(line, seenTools)) req.onTool(t);
  });

  // A harness that exits before reading its prompt breaks the pipe (EPIPE); the exit code reports it.
  child.stdin.on("error", () => {});
  child.stdin.end(req.prompt);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", (e) => {
      stderrTail += String(e);
      resolve(null);
    });
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(idle);
  clearTimeout(forceKill);
  egress.stop();
  // A container created while the CLI was being stopped is removed once it exits.
  if (killed && container) await removeContainer(container);
  await new Promise<void>((resolve) => log.end(resolve));
  const durationMs = Date.now() - started;

  if (!final || egress.blocked) {
    const why = req.signal?.aborted
      ? "Cancelled."
      : egress.blocked
        ? egress.blocked
        : idleFired
          ? `No output for ${Math.round(req.idleTimeoutMs / 60000)} minutes; the run was stopped.`
          : `The harness exited (code ${exitCode}) without a result. ${stderrTail.trim().slice(-800)}`;
    // Usage streamed before the end was spent; qwen and codex bill nothing per token.
    const estimate = req.harness === "claude" && streamed.seen;
    const costUsd = estimate ? streamed.usd : 0;
    return {
      ...failed(
        estimate
          ? `${why.trim()} Its cost ($${costUsd.toFixed(2)}) is estimated from the streamed token usage.`
          : why,
        durationMs,
      ),
      result: lastAssistantText,
      sessionId: initSession,
      costUsd,
    };
  }
  if (codex) {
    const failure =
      final.type === "turn.failed"
        ? ((final.error as { message?: string } | undefined)?.message ??
          "Turn failed.")
        : null;
    // ponytail: cost is 0 because ChatGPT-plan usage is not billed per token; add pricing if API keys are used.
    return {
      ok: !failure,
      sessionId: initSession,
      result: lastAssistantText,
      error: failure,
      costUsd: 0,
      numTurns: null,
      durationMs,
    };
  }
  const isError = final.is_error === true || final.subtype !== "success";
  return {
    ok: !isError,
    sessionId:
      typeof final.session_id === "string" ? final.session_id : initSession,
    result: typeof final.result === "string" ? final.result : lastAssistantText,
    error: isError ? `Run ended with ${String(final.subtype)}.` : null,
    costUsd: req.harness === "qwen" ? 0 : Number(final.total_cost_usd ?? 0),
    numTurns: typeof final.num_turns === "number" ? final.num_turns : null,
    durationMs,
  };
}

/** The external MCP tools a stream line calls, each call once (`seen` holds call ids). */
export function toolCalls(line: string, seen: Set<string>): string[] {
  let event: {
    type?: string;
    message?: { content?: { type?: string; id?: string; name?: string }[] };
    item?: { id?: string; type?: string; server?: string; tool?: string };
  };
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  // codex reports a call as item.started and again as item.completed.
  const calls =
    event.type === "assistant"
      ? (event.message?.content ?? [])
          .filter((c) => c.type === "tool_use")
          .map((c) => ({ id: c.id, name: c.name }))
      : event.item?.type === "mcp_tool_call"
        ? [
            {
              id: event.item.id,
              name: `mcp__${event.item.server}__${event.item.tool}`,
            },
          ]
        : [];
  return calls.flatMap(({ id, name }) => {
    if (!name?.startsWith("mcp__") || name.startsWith("mcp__nakara__"))
      return [];
    if (id) {
      if (seen.has(id)) return [];
      seen.add(id);
    }
    return [name];
  });
}

function failed(error: string, durationMs: number): TurnOutcome {
  return {
    ok: false,
    sessionId: null,
    result: null,
    error,
    costUsd: 0,
    numTurns: null,
    durationMs,
  };
}

function assistantText(event: Record<string, unknown>): string | null {
  const message = event.message as
    | { content?: { type: string; text?: string }[] }
    | undefined;
  const text = message?.content
    ?.filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
  return text || null;
}
