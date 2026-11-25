// The models a harness offers, asked from the CLI itself so the list stays
// current: Claude Code's control `initialize` and codex app-server's
// `model/list` (the same calls bb makes). qwen's gateway pins one model.
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";

export interface ModelOption {
  /** The value written to agent.md and passed to the CLI. */
  id: string;
  label: string;
  description: string;
  /** Effort levels in the CLI's own order; empty when the model has none. */
  efforts: string[];
  defaultEffort: string | null;
}

export type ModelHarness = "claude" | "codex";

interface ClaudeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportedEffortLevels?: string[];
}

/** Claude Code lists aliases first (opus → newest Opus), then pinned ids; keep one entry per model. */
export function claudeModels(models: ClaudeModelInfo[]): ModelOption[] {
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const m of models) {
    const resolved = m.resolvedModel ?? m.value;
    if (m.value === "default" || seen.has(resolved)) continue;
    seen.add(resolved);
    const efforts = m.supportedEffortLevels ?? [];
    out.push({
      id: m.value,
      label: m.displayName,
      description:
        m.value === resolved
          ? (m.description ?? "")
          : `Always the newest ${m.value}: ${resolved}`,
      efforts,
      defaultEffort: efforts.includes("high") ? "high" : (efforts[0] ?? null),
    });
  }
  return out;
}

interface CodexModelInfo {
  model: string;
  displayName: string;
  description?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string;
}

export function codexModels(models: CodexModelInfo[]): ModelOption[] {
  return models
    .filter((m) => !m.hidden)
    .map((m) => {
      const efforts = (m.supportedReasoningEfforts ?? []).map(
        (e) => e.reasoningEffort,
      );
      return {
        id: m.model,
        label: m.displayName,
        description: m.description ?? "",
        efforts,
        defaultEffort: m.defaultReasoningEffort ?? efforts[0] ?? null,
      };
    });
}

/** Writes `requests` as JSON lines and resolves with the first line `done` accepts. */
function converse<T>(
  bin: string,
  args: string[],
  requests: unknown[],
  done: (line: Record<string, unknown>) => T | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () => finish(new Error(`${bin} did not list its models in time`)),
      timeoutMs,
    );
    child.on("error", (error) => finish(error));
    // A CLI that exits before reading its input closes the pipe; the exit reports it.
    child.stdin.on("error", () => undefined);
    child.on("exit", (code) =>
      finish(
        new Error(
          `${bin} exited (code ${code}) without listing models. ${stderr.trim().slice(-500)}`,
        ),
      ),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    createInterface({ input: child.stdout }).on("line", (text) => {
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      try {
        const value = done(line);
        if (value !== undefined) finish(null, value);
      } catch (error) {
        finish(error as Error);
      }
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
  });
}

const PROBE_MS = 60_000;

async function probeClaude(bin: string): Promise<ModelOption[]> {
  return converse(
    bin,
    [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      // The operator's own hooks have no business in a model lookup.
      "--settings",
      '{"disableAllHooks":true}',
    ],
    [
      {
        type: "control_request",
        request_id: "models",
        request: { subtype: "initialize" },
      },
    ],
    (line) => {
      if (line.type !== "control_response") return undefined;
      const response = line.response as {
        subtype?: string;
        error?: string;
        response?: { models?: ClaudeModelInfo[] };
      };
      if (response.subtype === "error")
        throw new Error(response.error ?? "Claude Code refused initialize");
      return claudeModels(response.response?.models ?? []);
    },
    PROBE_MS,
  );
}

async function probeCodex(bin: string): Promise<ModelOption[]> {
  return converse(
    bin,
    ["app-server"],
    [
      {
        id: 0,
        method: "initialize",
        params: { clientInfo: { name: "nakara", version: "0" } },
      },
      { method: "initialized" },
      // shortcut: first page only; follow nextCursor when codex lists more than one page.
      { id: 1, method: "model/list", params: {} },
    ],
    (line) => {
      if (line.id !== 1) return undefined;
      if (line.error)
        throw new Error(
          (line.error as { message?: string }).message ?? "model/list failed",
        );
      return codexModels(
        (line.result as { data?: CodexModelInfo[] }).data ?? [],
      );
    },
    PROBE_MS,
  );
}

const CACHE_MS = 60 * 60_000;

/** Lists a harness's models, cached for an hour. */
export class ModelCatalog {
  private readonly cache = new Map<
    ModelHarness,
    { at: number; models: Promise<ModelOption[]> }
  >();
  private readonly bins: { claude: string; codex: string };
  private readonly probe: Record<
    ModelHarness,
    (bin: string) => Promise<ModelOption[]>
  >;
  constructor(
    bins: { claude: string; codex: string },
    probe = { claude: probeClaude, codex: probeCodex },
  ) {
    this.bins = bins;
    this.probe = probe;
  }

  list(harness: ModelHarness): Promise<ModelOption[]> {
    const hit = this.cache.get(harness);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.models;
    const models = this.probe[harness](this.bins[harness]);
    this.cache.set(harness, { at: Date.now(), models });
    // A failed lookup is not cached, so the next request asks again.
    models.catch(() => {
      if (this.cache.get(harness)?.models === models)
        this.cache.delete(harness);
    });
    return models;
  }
}
