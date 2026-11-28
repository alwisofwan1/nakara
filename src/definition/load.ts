import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  isMap,
  isNode,
  isSeq,
  LineCounter,
  parseDocument,
  parse as parseYaml,
} from "yaml";
import type { z } from "zod";

import type { AgentType } from "../domain/policy.ts";
import { parseCron } from "../intake/schedule.ts";
import { allowedHost } from "../runner/egress-proxy.ts";
import { harnessUnreachable, sandboxOf } from "./reach.ts";
import {
  agentFrontmatterSchema,
  automationFrontmatterSchema,
  factorySchema,
  runnerSchema,
  scorerFrontmatterSchema,
  type AgentFrontmatter,
  type AutomationFrontmatter,
  type FallbackSpec,
  type FactoryFile,
  type HarnessSpec,
  type McpServer,
  type RunnerFile,
  type ScorerFrontmatter,
} from "./schema.ts";

export type HarnessKind = "claude" | "qwen" | "codex";
export interface ResolvedHarness {
  kind: HarnessKind;
  /** Model passed to the CLI; undefined means the CLI default. */
  model: string | undefined;
  /** `harness.reasoningLevel`, passed as the CLI's effort; undefined means its default. */
  effort?: string | undefined;
}

/**
 * The harness an agent runs on when neither it nor agentDefaults names one.
 * Not to be confused with an agent's `fallback` harnesses (AgentDef.fallback).
 */
export const HARNESS_DEFAULT: ResolvedHarness = {
  kind: "claude",
  model: undefined,
};

/** The entries of a definition folder that loadDefinition reads; the rest of the folder is not the definition. */
export const DEFINITION_ENTRIES = [
  "factory.yaml",
  "agents",
  "automations",
  "runners",
  "scorers",
  "skills",
] as const;

/** `{{NAME}}` in an MCP server's arguments, env, URL or headers names a secret. */
export const SECRET_REF = /\{\{(\w+)\}\}/g;

// Nakara's own credentials and configuration never reach an agent as secrets.
const RESERVED_SECRET =
  /^(NAKARA_|CLAUDE_|ANTHROPIC_|OPENAI_|CODEX_)|^(GH|GITHUB)(_ENTERPRISE)?_TOKEN$/;

/** Each secret reference in a server, with the key path of the string holding it. */
function secretRefs(s: McpServer): { at: (string | number)[]; name: string }[] {
  const fields: [(string | number)[], string][] =
    "command" in s
      ? [
          ...(s.args ?? []).map((v, i): [(string | number)[], string] => [
            ["args", i],
            v,
          ]),
          ...Object.entries(s.env ?? {}).map(
            ([k, v]): [(string | number)[], string] => [["env", k], v],
          ),
        ]
      : "url" in s
        ? [
            [["url"], s.url],
            ...Object.entries(s.headers ?? {}).map(
              ([k, v]): [(string | number)[], string] => [["headers", k], v],
            ),
          ]
        : [];
  return fields.flatMap(([at, v]) =>
    [...v.matchAll(SECRET_REF)].map((m) => ({ at, name: m[1] as string })),
  );
}

const WRITE_VERBS = new Set([
  "create",
  "update",
  "delete",
  "post",
  "send",
  "write",
  "merge",
  "close",
]);

/** create_issue, issues-update or sendMessage: a tool named for a change. */
const writesLike = (tool: string) =>
  tool.split(/[_-]|(?=[A-Z])/).some((w) => WRITE_VERBS.has(w.toLowerCase()));

export interface Skill {
  name: string;
  path: string;
}

export interface AgentDef {
  name: string;
  type: AgentType;
  description: string;
  instructions: string;
  harness: ResolvedHarness;
  /**
   * The harnesses a fresh run moves to, in order, when its harness hits a
   * rate or usage limit (`fallback` in its frontmatter or agentDefaults).
   */
  fallback: ResolvedHarness[];
  runner: string | undefined;
  mcpServers: Record<string, McpServer>;
  /** Secret names the agent may use: factory `secrets` plus its own or agentDefaults'. */
  secrets: string[];
  spawnableBy: string[] | undefined;
  idleTimeoutMinutes: number;
  skills: Skill[];
  /** Agent-level overrides; resolved values above remain the execution source of truth. */
  explicitSettings?: string[];
  /** Names of the skills under agents/<name>/skills; the rest are shared. */
  localSkills?: string[];
  /** The agent.md frontmatter as written, which the settings editor starts from. */
  frontmatter?: AgentFrontmatter;
  /** fileRevision of the agent.md bytes this definition was loaded from. */
  revision?: string;
}

export interface AutomationDef {
  name: string;
  agent: string;
  instructions: string;
  frontmatter: AutomationFrontmatter;
  /** fileRevision of the automation.md bytes this definition was loaded from. */
  revision?: string;
}

export interface Definition {
  root: string;
  factory: FactoryFile;
  alias: string;
  label: string;
  agents: Map<string, AgentDef>;
  foreman: AgentDef;
  automations: AutomationDef[];
  runners: Map<string, RunnerFile>;
  scorers: Map<string, { frontmatter: ScorerFrontmatter; rubric: string }>;
  loadedAt: string;
}

export interface Problem {
  path: string;
  message: string;
  /** 1-based line in the file, when the problem points at one. */
  line?: number;
}

export type LoadResult =
  | { ok: true; definition: Definition; warnings: Problem[] }
  | { ok: false; errors: Problem[]; warnings: Problem[] };

/** A trigger filter value as a list: one value, a list, or `{ in: list }`. */
export const filterList = (v: unknown): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "object" && "in" in v)
    return filterList((v as { in: unknown }).in);
  return [String(v)];
};

/** The `owner/name` repositories of the definition's Factory. */
export function factoryRepositories(definition: Definition): string[] {
  return definition.factory.repositories.map((r) => `${r.owner}/${r.name}`);
}

/** Whether the definition has an agent of the type its Foreman may dispatch. */
const dispatchable = (definition: Definition, type: AgentType): boolean =>
  [...definition.agents.values()].some(
    (a) =>
      a.type === type &&
      (!a.spawnableBy || a.spawnableBy.includes(definition.foreman.name)),
  );

/** Whether the definition has a SPEC agent its Foreman may dispatch. */
export function hasSpecAgent(definition: Definition): boolean {
  return dispatchable(definition, "SPEC");
}

/** Whether the definition has a VERIFY agent its Foreman may dispatch. */
export function hasVerifyAgent(definition: Definition): boolean {
  return dispatchable(definition, "VERIFY");
}

/**
 * The `owner/name` repositories a definition claims, each with the file that
 * claims it: the factory's repositories, and the repos filter of every GitHub
 * trigger. Each repository belongs to one factory.
 */
export function repoClaims(
  definition: Definition,
): { repo: string; path: string }[] {
  return [
    ...definition.factory.repositories.map((r) => ({
      repo: `${r.owner}/${r.name}`,
      path: "factory.yaml",
    })),
    ...definition.automations.flatMap((automation) =>
      automation.frontmatter.triggers
        .filter((t) => t.provider === "github")
        .flatMap((t) => filterList(t.filter?.repos) ?? [])
        .map((repo) => ({
          repo,
          path: `automations/${automation.name}/automation.md`,
        })),
    ),
  ];
}

/** Split `---\nyaml\n---\nbody` into frontmatter and body. Frontmatter is optional. */
export function splitFrontmatter(text: string): {
  data: unknown;
  body: string;
} {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  return {
    data: parseYaml(match[1] ?? "") ?? {},
    body: (match[2] ?? "").trim(),
  };
}

type YamlPath = readonly (string | number)[];
interface YamlSource {
  data: unknown;
  /** Line of the deepest existing key along `path`, preferring the key over its value. */
  line: (path: YamlPath) => number | undefined;
}

/** Parse YAML that starts `offset` lines into its file; syntax errors carry their line. */
function readYaml(
  text: string,
  offset = 0,
): YamlSource | { error: string; line: number | undefined } {
  const counter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter: counter,
    prettyErrors: false,
  });
  const at = (pos: number | undefined) =>
    pos === undefined ? undefined : counter.linePos(pos).line + offset;
  const first = doc.errors[0];
  if (first) return { error: first.message, line: at(first.pos[0]) };
  const line = (path: YamlPath) => {
    for (let i = path.length; i > 0; i--) {
      const parent =
        i === 1 ? doc.contents : doc.getIn(path.slice(0, i - 1), true);
      const key = path[i - 1];
      const node = isMap(parent)
        ? parent.items.find(
            (pair) => isNode(pair.key) && pair.key.toJSON() === key,
          )?.key
        : isSeq(parent) && typeof key === "number"
          ? parent.items[key]
          : undefined;
      if (isNode(node) && node.range) return at(node.range[0]);
    }
    return isNode(doc.contents) && doc.contents.range
      ? at(doc.contents.range[0])
      : undefined;
  };
  return { data: doc.toJS() ?? {}, line };
}

/** `---` yaml `---` body; group 1 is the YAML without its last line break, group 2 the body. */
export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Identifies the exact bytes of a file, so a stale edit can be detected. */
export const fileRevision = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

// Warp's `model` shorthand names hosted models. Map the families we can run
// locally; anything else falls back to the CLI default with a warning.
export function resolveHarness(
  spec: { model?: string | undefined; harness?: HarnessSpec | undefined },
  fallback: ResolvedHarness,
): { harness: ResolvedHarness; warning?: string } {
  if (spec.harness) {
    const t = spec.harness.type;
    if (t === "claude" || t === "claude-code")
      return {
        harness: {
          kind: "claude",
          model: spec.harness.model && claudeModel(spec.harness.model),
          ...effort(spec.harness),
        },
      };
    if (t === "qwen") return { harness: { kind: "qwen", model: undefined } };
    if (t === "codex") {
      const m = spec.harness.model;
      return {
        harness: {
          kind: "codex",
          model: m && !m.startsWith("auto") ? m : undefined,
          ...effort(spec.harness),
        },
      };
    }
    return {
      harness: fallback,
      warning: `harness type "${t}" runs on Warp only; using ${fallback.kind}`,
    };
  }
  if (spec.model === undefined) return { harness: fallback };
  const m = spec.model.toLowerCase();
  if (m.startsWith("qwen"))
    return { harness: { kind: "qwen", model: undefined } };
  if (m.startsWith("auto"))
    return { harness: { kind: "claude", model: undefined } };
  const mapped = claudeModel(m);
  if (mapped) return { harness: { kind: "claude", model: mapped } };
  return {
    harness: { kind: "claude", model: undefined },
    warning: `model "${spec.model}" is not available locally; using the Claude Code default`,
  };
}

/** The harness kinds a fallback may name: the ones that run locally. */
const FALLBACK_KINDS = ["claude", "claude-code", "codex", "qwen"];

/**
 * A `fallback` list as harnesses, without the agent's own harness or a
 * repeat; an entry of a kind that cannot run locally is an error.
 */
export function resolveFallback(
  specs: FallbackSpec[],
  own: ResolvedHarness,
): {
  fallback: ResolvedHarness[];
  /** The index in `specs` of each harness in `fallback`. */
  at: number[];
  errors: { index: number; message: string }[];
} {
  const fallback: ResolvedHarness[] = [];
  const at: number[] = [];
  const errors: { index: number; message: string }[] = [];
  const same = (a: ResolvedHarness, b: ResolvedHarness) =>
    a.kind === b.kind && a.model === b.model;
  for (const [index, spec] of specs.entries()) {
    const harness = typeof spec === "string" ? { type: spec } : spec;
    if (!FALLBACK_KINDS.includes(harness.type)) {
      errors.push({
        index,
        message: `fallback: unknown harness "${harness.type}"; use claude, codex or qwen`,
      });
      continue;
    }
    const resolved = resolveHarness(
      { harness: harness as HarnessSpec },
      HARNESS_DEFAULT,
    ).harness;
    if (!same(resolved, own) && !fallback.some((f) => same(f, resolved))) {
      fallback.push(resolved);
      at.push(index);
    }
  }
  return { fallback, at, errors };
}

const effort = (h: HarnessSpec) =>
  h.reasoningLevel ? { effort: h.reasoningLevel } : {};

function claudeModel(model: string): string | undefined {
  const m = model.toLowerCase();
  // Claude Code's own names (an alias, or an id like claude-opus-4-8) run as
  // written; Warp's hosted names (claude-5-opus-high) map to their family.
  if (/^(opus|sonnet|haiku|fable)$/.test(m) || /^claude-[a-z]+-\d/.test(m))
    return model;
  for (const family of ["opus", "sonnet", "haiku", "fable"])
    if (m.includes(family)) return family;
  if (m.startsWith("claude-")) return model;
  return undefined;
}

const exists = async (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );
const subdirs = async (p: string) =>
  (await exists(p))
    ? (await readdir(p, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];

async function skillsIn(dir: string): Promise<Skill[]> {
  const names = await subdirs(dir);
  const found: Skill[] = [];
  for (const name of names) {
    const path = join(dir, name, "SKILL.md");
    if (await exists(path)) found.push({ name, path });
  }
  return found;
}

// Event providers Nakara can deliver today; others load but never fire.
const SUPPORTED_TRIGGERS = new Set([
  "nakara:manual",
  "github:issue_labeled",
  "github:pull_request_merged",
  "github:pull_request_closed",
  "schedule:cron_fired",
  "telegram:message",
  "slack:message",
]);
/** A Slack member ID, as in a profile's "Copy member ID". */
const SLACK_MEMBER = /^[UW][A-Z0-9]{2,}$/;

export async function loadDefinition(
  root: string,
  defaults: ResolvedHarness,
): Promise<LoadResult> {
  const errors: Problem[] = [];
  const warnings: Problem[] = [];
  const rel = (p: string) => relative(root, p) || ".";

  const problem = (
    path: string,
    message: string,
    line: number | undefined,
  ): Problem => ({
    path: rel(path),
    message,
    ...(line === undefined ? {} : { line }),
  });
  const parse = <S extends z.ZodType>(
    schema: S,
    source: YamlSource,
    path: string,
  ): z.infer<S> | undefined => {
    const result = schema.safeParse(source.data);
    if (result.success) return result.data;
    for (const issue of result.error.issues)
      errors.push(
        problem(
          path,
          `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          source.line(issue.path.filter((k) => typeof k !== "symbol")),
        ),
      );
    return undefined;
  };
  /** Read a YAML file, or a Markdown file's optional frontmatter, recording syntax errors. */
  const read = async (path: string, markdown = false) => {
    const bytes = await readFile(path);
    const text = bytes.toString("utf8");
    const match = markdown ? FRONTMATTER.exec(text) : null;
    const body = markdown ? (match ? (match[2] ?? "") : text).trim() : "";
    const yaml = markdown ? (match?.[1] ?? "") : text;
    const source = readYaml(yaml, markdown ? 1 : 0);
    if ("error" in source) {
      errors.push(problem(path, source.error, source.line));
      return undefined;
    }
    return { source, body, revision: fileRevision(bytes) };
  };

  const factoryPath = join(root, "factory.yaml");
  if (!(await exists(factoryPath)))
    return {
      ok: false,
      errors: [{ path: "factory.yaml", message: "missing" }],
      warnings,
    };
  const factoryFile = await read(factoryPath);
  const factory =
    factoryFile && parse(factorySchema, factoryFile.source, factoryPath);
  if (!factoryFile || !factory) return { ok: false, errors, warnings };
  const factoryLine = factoryFile.source.line;

  for (const [i, integration] of (factory.integrations ?? []).entries())
    warnings.push(
      problem(
        factoryPath,
        `integration "${integration.type}" is not supported yet; ignored`,
        factoryLine(["integrations", i]),
      ),
    );

  const base = resolveHarness(factory.agentDefaults, defaults);
  if (base.warning)
    warnings.push(
      problem(factoryPath, base.warning, factoryLine(["agentDefaults"])),
    );
  for (const { index, message } of resolveFallback(
    factory.agentDefaults.fallback ?? [],
    base.harness,
  ).errors)
    errors.push(
      problem(
        factoryPath,
        message,
        factoryLine(["agentDefaults", "fallback", index]),
      ),
    );
  const sharedSkills = await skillsIn(join(root, "skills"));

  const runners = new Map<string, RunnerFile>();
  const runnersDir = join(root, "runners");
  if (await exists(runnersDir)) {
    for (const file of (await readdir(runnersDir))
      .filter((f) => f.endsWith(".yaml"))
      .sort()) {
      const path = join(runnersDir, file);
      const runnerFile = await read(path);
      const runner = runnerFile && parse(runnerSchema, runnerFile.source, path);
      if (runner) runners.set(file.replace(/\.yaml$/, ""), runner);
    }
  }

  for (const at of [["secrets"], ["agentDefaults", "secrets"]] as const)
    for (const [i, name] of (
      (at.length === 1 ? factory.secrets : factory.agentDefaults.secrets) ?? []
    ).entries())
      if (RESERVED_SECRET.test(name))
        errors.push(
          problem(
            factoryPath,
            `secret ${name} is Nakara's own configuration and cannot be given to agents`,
            factoryLine([...at, i]),
          ),
        );

  const defaultRunner = factory.agentDefaults.runner;
  if (defaultRunner && !runners.has(defaultRunner))
    errors.push(
      problem(
        factoryPath,
        `runner "${defaultRunner}" is not defined`,
        factoryLine(["agentDefaults", "runner"]),
      ),
    );

  for (const [i, repo] of factory.repositories.entries()) {
    if (!repo.runner) continue;
    const runner = runners.get(repo.runner);
    if (!runner)
      errors.push(
        problem(
          factoryPath,
          `runner "${repo.runner}" is not defined`,
          factoryLine(["repositories", i, "runner"]),
        ),
      );
    else if (!runner.platform?.linux?.dockerImage)
      errors.push(
        problem(
          factoryPath,
          `runner "${repo.runner}" has no dockerImage; verify commands run only in a container`,
          factoryLine(["repositories", i, "runner"]),
        ),
      );
  }

  const agents = new Map<string, AgentDef>();
  for (const name of await subdirs(join(root, "agents"))) {
    const path = join(root, "agents", name, "agent.md");
    if (!(await exists(path))) continue;
    const file = await read(path, true);
    const fm = file && parse(agentFrontmatterSchema, file.source, path);
    if (!file || !fm) continue;
    const { body } = file;
    const line = file.source.line;
    const harnessLine = line([fm.harness ? "harness" : "model"]);
    const resolved =
      fm.model || fm.harness
        ? resolveHarness(fm, base.harness)
        : { harness: base.harness };
    if (resolved.warning)
      warnings.push(problem(path, resolved.warning, harnessLine));
    // An agent's own list replaces agentDefaults'; the defaults' errors are reported once, above.
    const fallbackSpec = fm.fallback ?? factory.agentDefaults.fallback ?? [];
    const fallbacks = resolveFallback(fallbackSpec, resolved.harness);
    if (fm.fallback)
      for (const { index, message } of fallbacks.errors)
        errors.push(problem(path, message, line(["fallback", index])));
    const fallbackLine = (i: number) =>
      fm.fallback
        ? ([path, line(["fallback", i])] as const)
        : ([
            factoryPath,
            factoryLine(["agentDefaults", "fallback", i]),
          ] as const);
    const mcpServers = {
      ...factory.mcpServers,
      ...(fm.mcpServers ?? factory.agentDefaults.mcpServers ?? {}),
    };
    const runner = fm.runner ?? factory.agentDefaults.runner;
    const sandbox = sandboxOf(runners, runner)?.allow;
    for (const [i, secret] of (fm.secrets ?? []).entries())
      if (RESERVED_SECRET.test(secret))
        errors.push(
          problem(
            path,
            `secret ${secret} is Nakara's own configuration and cannot be given to agents`,
            line(["secrets", i]),
          ),
        );
    const secrets = [
      ...new Set([
        ...(factory.secrets ?? []),
        ...(fm.secrets ?? factory.agentDefaults.secrets ?? []),
      ]),
    ];
    for (const [server, spec] of Object.entries(mcpServers)) {
      // Report the reference where the server is written.
      const [file, lineOf, at] = fm.mcpServers?.[server]
        ? [path, line, ["mcpServers", server]]
        : !fm.mcpServers && factory.agentDefaults.mcpServers?.[server]
          ? [factoryPath, factoryLine, ["agentDefaults", "mcpServers", server]]
          : [factoryPath, factoryLine, ["mcpServers", server]];
      for (const ref of secretRefs(spec))
        if (!secrets.includes(ref.name))
          errors.push(
            problem(
              file,
              `mcpServers.${server}: {{${ref.name}}} is not in the secrets of agent "${name}"; declare it under secrets`,
              lineOf([...at, ...ref.at]),
            ),
          );
      if ("warpId" in spec) continue;
      const host = "url" in spec ? URL.parse(spec.url)?.hostname : undefined;
      if (host && sandbox && !allowedHost(host, sandbox))
        errors.push(
          problem(
            file,
            `mcpServers.${server}: ${host} is not in the egress allow list of runner "${runner}", so agent "${name}" cannot reach it; add it under egress.allow`,
            lineOf([...at, "url"]),
          ),
        );
      // A foreman without a sandbox is refused or flagged separately (ADR 0003); a local agent's is not.
      else if (host && !sandbox && fm.agentType !== "FOREMAN")
        warnings.push(
          problem(
            file,
            `mcpServers.${server}: agent "${name}" runs on the host, so no egress allow list limits what it reaches`,
            lineOf([...at, "url"]),
          ),
        );
      if (
        "command" in spec &&
        fm.agentType === "FOREMAN" &&
        !sandbox &&
        process.env.NAKARA_ALLOW_HOST_FOREMAN !== "1"
      )
        errors.push(
          problem(
            file,
            `mcpServers.${server}: the foreman's runner "${runner ?? "(none)"}" has no dockerImage, so a command server would run on the host unsandboxed; give the runner a dockerImage, use a url server, or set NAKARA_ALLOW_HOST_FOREMAN=1 to accept that`,
            lineOf([...at, "command"]),
          ),
        );
      if (fm.agentType !== "FOREMAN") {
        // Agents run with bypassPermissions, which an allowlist cannot narrow.
        if (spec.tools && file === path)
          warnings.push(
            problem(
              file,
              `mcpServers.${server}: tools limits the foreman only; agent "${name}" can call every tool of the server`,
              lineOf([...at, "tools"]),
            ),
          );
        continue;
      }
      if (!spec.tools)
        errors.push(
          problem(
            file,
            `mcpServers.${server}: the foreman needs a tools list naming what it may call`,
            lineOf(at),
          ),
        );
      for (const [i, tool] of (spec.tools ?? []).entries())
        if (writesLike(tool))
          warnings.push(
            problem(
              file,
              `mcpServers.${server}: the foreman may call ${tool}, which looks like it changes something outside Nakara`,
              lineOf([...at, "tools", i]),
            ),
          );
    }
    const unreachable = harnessUnreachable(
      name,
      resolved.harness.kind,
      runner,
      sandbox,
    );
    if (unreachable) warnings.push(problem(path, unreachable, harnessLine));
    for (const [i, h] of fallbacks.fallback.entries()) {
      const [file, at] = fallbackLine(fallbacks.at[i] ?? 0);
      const why = harnessUnreachable(name, h.kind, runner, sandbox);
      if (why) warnings.push(problem(file, `fallback: ${why}`, at));
      if (h.kind !== "codex") continue;
      // The rules of the codex harness hold for a fallback to it too.
      if (fm.agentType === "FOREMAN")
        errors.push(
          problem(
            file,
            `fallback: the foreman cannot use the codex harness (it needs the nakara MCP tools)`,
            at,
          ),
        );
      else if (Object.keys(mcpServers).length)
        errors.push(
          problem(
            file,
            `fallback: codex agents cannot use mcpServers yet, so agent "${name}" cannot fall back to codex`,
            at,
          ),
        );
    }
    if (resolved.harness.kind === "codex" && fm.agentType === "FOREMAN")
      errors.push(
        problem(
          path,
          "the foreman cannot use the codex harness (it needs the nakara MCP tools)",
          harnessLine,
        ),
      );
    if (resolved.harness.kind === "codex" && Object.keys(mcpServers).length)
      errors.push(
        problem(
          path,
          "codex agents cannot use mcpServers yet",
          line([fm.mcpServers ? "mcpServers" : "harness"]),
        ),
      );
    if (fm.runner && !runners.has(fm.runner))
      errors.push(
        problem(path, `runner "${fm.runner}" is not defined`, line(["runner"])),
      );
    const localSkills = await skillsIn(join(root, "agents", name, "skills"));
    agents.set(name, {
      explicitSettings: [
        ...Object.keys(fm).filter(
          (key) => key !== "model" && fm[key as keyof typeof fm] != null,
        ),
        ...(fm.model !== undefined || fm.harness !== undefined
          ? ["harness"]
          : []),
        // Some harnesses drop the requested model (qwen), so only a resolved one counts.
        ...(resolved.harness.model !== undefined &&
        (fm.model !== undefined || fm.harness?.model !== undefined)
          ? ["model"]
          : []),
      ],
      localSkills: localSkills.map((s) => s.name),
      frontmatter: fm,
      revision: file.revision,
      name,
      type: fm.agentType,
      description: fm.description ?? "",
      instructions: body,
      harness: resolved.harness,
      fallback: fallbacks.fallback,
      runner,
      mcpServers,
      secrets,
      spawnableBy: fm.spawnableBy,
      idleTimeoutMinutes:
        fm.idleTimeoutMinutes ?? factory.agentDefaults.idleTimeoutMinutes ?? 60,
      skills: [...sharedSkills, ...localSkills],
    });
  }

  const foremen = [...agents.values()].filter((a) => a.type === "FOREMAN");
  if (foremen.length !== 1)
    errors.push({
      path: "agents/",
      message: `exactly one agent must declare agentType: FOREMAN (found ${foremen.length})`,
    });

  const automations: AutomationDef[] = [];
  for (const name of await subdirs(join(root, "automations"))) {
    const path = join(root, "automations", name, "automation.md");
    if (!(await exists(path))) continue;
    const file = await read(path, true);
    const fm = file && parse(automationFrontmatterSchema, file.source, path);
    if (!file || !fm) continue;
    const { body } = file;
    const line = file.source.line;
    const agent = fm.agent ?? foremen[0]?.name ?? "";
    if (fm.agent && !agents.has(fm.agent))
      errors.push(
        problem(path, `agent "${fm.agent}" is not defined`, line(["agent"])),
      );
    for (const [i, t] of fm.triggers.entries()) {
      if (!SUPPORTED_TRIGGERS.has(`${t.provider}:${t.event}`))
        warnings.push(
          problem(
            path,
            `trigger ${t.provider}/${t.event} is not supported yet; it will not fire`,
            line(["triggers", i]),
          ),
        );
      if (t.provider === "slack") {
        const members = t.filter?.members;
        if (
          !Array.isArray(members) ||
          !members.length ||
          !members.every((m) => typeof m === "string" && SLACK_MEMBER.test(m))
        )
          errors.push(
            problem(
              path,
              "a slack trigger needs filter.members: the Slack member IDs (U…) allowed to send requests and answer",
              line(["triggers", i]),
            ),
          );
      }
      if (t.provider === "schedule")
        try {
          if (!t.schedule) throw new Error("schedule.cron is required");
          parseCron(t.schedule.cron);
        } catch (e) {
          errors.push(
            problem(
              path,
              (e as Error).message,
              line(["triggers", i, "schedule", "cron"]),
            ),
          );
        }
    }
    automations.push({
      name,
      agent,
      instructions: body,
      frontmatter: fm,
      revision: file.revision,
    });
  }

  const scorers = new Map<
    string,
    { frontmatter: ScorerFrontmatter; rubric: string }
  >();
  for (const name of await subdirs(join(root, "scorers"))) {
    const path = join(root, "scorers", name, "scorer.md");
    if (!(await exists(path))) continue;
    const file = await read(path, true);
    const fm = file && parse(scorerFrontmatterSchema, file.source, path);
    if (file && fm) scorers.set(name, { frontmatter: fm, rubric: file.body });
  }
  if (scorers.size > 0)
    warnings.push({
      path: "scorers/",
      message: "scorers are loaded but not run yet",
    });

  const foreman = foremen[0];
  if (errors.length > 0 || !foreman) return { ok: false, errors, warnings };
  const alias = factory.alias ?? factory.name;
  return {
    ok: true,
    warnings,
    definition: {
      root,
      factory,
      alias,
      label: `factory:${alias}`,
      agents,
      foreman,
      automations,
      runners,
      scorers,
      loadedAt: new Date().toISOString(),
    },
  };
}
