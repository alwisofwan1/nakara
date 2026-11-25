// Turns the new-factory wizard's choices into a v1alpha1 definition tree in
// memory. The tree is validated with the loader before anything is written, and
// the CLI (`npm run scaffold`) and the wizard share this module.
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { parseDocument, stringify } from "yaml";

import type { AgentType } from "../domain/policy.ts";
import {
  filterList,
  HARNESS_FALLBACK,
  loadDefinition,
  type Problem,
  repoClaims,
  resolveHarness,
  splitFrontmatter,
} from "./load.ts";
import { slugify } from "./seed.ts";
import { type Put, serializeMarkdown } from "./write.ts";

/** Relative path (with `/`) → file content; bytes for files that are not UTF-8 text. */
export type FileTree = Map<string, string | Uint8Array>;

export type Template =
  | { kind: "nakara" }
  /** `example` is a folder under examples/ in warpdotdev/warp-factory-examples. */
  | { kind: "warp"; example?: string }
  /** An existing definition directory; only the given choices change it. */
  | { kind: "import"; from: string }
  | { kind: "blank" };

/** The agents the wizard toggles; implement and the foreman are always on. */
export type AgentRole = "foreman" | "triage" | "spec" | "implement" | "review";
export type HarnessChoice = "claude" | "codex" | "qwen";

export interface ScaffoldChoices {
  /** Display name: the factory's alias and label (`factory:<name>`). */
  name: string;
  /** The foreman's `@handle`; defaults to the slug of the name. */
  handle?: string;
  description?: string;
  repositories: { owner: string; name: string }[];
  template: Template;
  /** Unset fields keep the template's agents and harnesses. */
  agents?: Partial<
    Record<AgentRole, { enabled?: boolean; harness?: HarnessChoice }>
  >;
  /**
   * Web intake is always on. Unset means the default (GitHub label only) for
   * a template and no change for an import.
   */
  intake?: {
    github?: boolean;
    telegram?: boolean;
    /** A cron schedule, or null to remove scheduled automations. */
    schedule?: { cron: string; instructions?: string } | null;
  };
}

export interface ScaffoldDeps {
  /** The tree the Nakara template copies; defaults to the bundled factory/. */
  nakaraDir?: string;
  /** Shallow-clones warpdotdev/warp-factory-examples into `dest`. */
  cloneWarpExamples?: (dest: string) => Promise<void>;
}

/** What the registry needs besides the files. */
export interface ScaffoldedFactory {
  slug: string;
  name: string;
  description: string;
  foremanHandle: string;
}

export type ScaffoldResult =
  | {
      ok: true;
      files: FileTree;
      factory: ScaffoldedFactory;
      /** The repositories the definition claims (see repoClaims), with the file that claims each. */
      claims: { repo: string; path: string }[];
      warnings: Problem[];
    }
  | { ok: false; errors: Problem[]; warnings: Problem[] };

export const WARP_EXAMPLES_REPO =
  "https://github.com/warpdotdev/warp-factory-examples.git";
export const DEFAULT_WARP_EXAMPLE = "00-warp-default-agents";
const WARP_LICENSE = "LICENSE.warp-examples";
const BUNDLED = join(import.meta.dirname, "../../factory");
/** A foreman `@handle`: lowercase letters, digits and inner dashes, at most 40. */
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const ROLE_TYPES: Record<AgentRole, AgentType> = {
  foreman: "FOREMAN",
  triage: "TRIAGE",
  spec: "SPEC",
  implement: "IMPLEMENT",
  review: "REVIEW",
};

const DEFAULT_INTAKE = { github: true, telegram: false, schedule: null };

const execFileAsync = promisify(execFile);
export async function cloneWarpExamples(dest: string): Promise<void> {
  await execFileAsync("git", [
    "clone",
    "--depth",
    "1",
    "--quiet",
    WARP_EXAMPLES_REPO,
    dest,
  ]);
}

export async function scaffold(
  choices: ScaffoldChoices,
  deps: ScaffoldDeps = {},
): Promise<ScaffoldResult> {
  const fail = (message: string, path = "."): ScaffoldResult => ({
    ok: false,
    errors: [{ path, message }],
    warnings: [],
  });
  const name = choices.name.trim();
  if (!name) return fail("a factory name is required");
  const slug = slugify(name);
  const handle = choices.handle?.trim() || slug;
  if (!HANDLE.test(handle))
    return fail(
      `handle "${handle}" must be lowercase letters, digits and inner dashes`,
    );
  for (const role of ["foreman", "implement"] as const)
    if (choices.agents?.[role]?.enabled === false)
      return fail(`the ${role} agent is always on`);

  const template = choices.template;
  let files: FileTree;
  try {
    files = await baseTree(template, deps);
  } catch (error) {
    return fail(`${template.kind} template: ${(error as Error).message}`);
  }
  const imported = template.kind === "import";
  try {
    applyFactory(files, { slug, name, choices });
    if (template.kind === "warp")
      adoptWarpFilters(files, `factory:${name}`, choices.repositories);
    applyAgents(files, choices.agents ?? {});
    applyIntake(
      files,
      imported
        ? (choices.intake ?? {})
        : { ...DEFAULT_INTAKE, ...choices.intake },
      `factory:${name}`,
    );
  } catch (error) {
    return fail((error as Error).message);
  }

  const checked = await validate(files);
  if (!checked.ok) return checked;
  return {
    ok: true,
    files,
    warnings: checked.warnings,
    claims: checked.claims,
    factory: {
      slug,
      name: checked.alias,
      description: checked.description,
      foremanHandle: handle,
    },
  };
}

/** An agent a template starts with, before the wizard's choices. */
export interface TemplateAgent {
  /** The folder name under agents/. */
  name: string;
  /** The wizard's toggle and harness choice it follows; null for a custom agent. */
  role: AgentRole | null;
  description: string;
  harness: string;
  model: string | null;
}

/** What a template starts with, before the wizard's choices. */
export interface TemplateInfo {
  /** In the wizard's role order, then custom agents by name. */
  agents: TemplateAgent[];
  /** The intake its automations already have; only an import keeps it by default. */
  intake: { github: boolean; telegram: boolean; schedule: string | null };
}

export async function readTemplate(
  template: Template,
  deps: ScaffoldDeps = {},
): Promise<TemplateInfo> {
  const files = await baseTree(template, deps);
  return { agents: templateAgents(files), intake: templateIntake(files) };
}

function templateIntake(files: FileTree): TemplateInfo["intake"] {
  const [scheduled] = automationsFor(files, "schedule", "cron_fired");
  const cron = scheduled
    ? (
        splitFrontmatter(textOf(files, `${scheduled}/automation.md`)).data as {
          triggers?: { schedule?: { cron?: unknown } }[];
        }
      ).triggers?.[0]?.schedule?.cron
    : undefined;
  return {
    // As in applyIntake, an automation routed by another label is not the intake.
    github:
      automationsFor(files, "github", "issue_labeled", (t) => {
        const labels = filterList(t.filter?.labels);
        return !labels || labels.some((l) => l.startsWith("factory:"));
      }).length > 0,
    telegram: automationsFor(files, "telegram", "message").length > 0,
    schedule: typeof cron === "string" ? cron : null,
  };
}

function templateAgents(files: FileTree): TemplateAgent[] {
  const factory = (parseDocument(textOf(files, "factory.yaml")).toJS() ??
    {}) as { agentDefaults?: Parameters<typeof resolveHarness>[0] };
  const inherited = resolveHarness(
    factory.agentDefaults ?? {},
    HARNESS_FALLBACK,
  ).harness;
  const roles = Object.entries(ROLE_TYPES) as [AgentRole, AgentType][];
  const agents: TemplateAgent[] = [];
  for (const agent of agentFiles(files)) {
    const fm = splitFrontmatter(agent.text).data as Parameters<
      typeof resolveHarness
    >[0] & { description?: unknown };
    const harness =
      fm.model || fm.harness
        ? resolveHarness(fm, HARNESS_FALLBACK).harness
        : inherited;
    agents.push({
      name: agent.dir.slice("agents/".length),
      role: roles.find(([, type]) => type === agent.type)?.[0] ?? null,
      description: typeof fm.description === "string" ? fm.description : "",
      harness: harness.kind,
      model: harness.model ?? null,
    });
  }
  const order = (a: TemplateAgent) =>
    a.role ? roles.findIndex(([role]) => role === a.role) : roles.length;
  return agents.sort(
    (a, b) => order(a) - order(b) || a.name.localeCompare(b.name),
  );
}

/** The example folders of warpdotdev/warp-factory-examples. */
export async function warpExamples(deps: ScaffoldDeps = {}): Promise<string[]> {
  const scratch = await mkdtemp(join(tmpdir(), "nakara-warp-"));
  try {
    const clone = join(scratch, "warp-factory-examples");
    await (deps.cloneWarpExamples ?? cloneWarpExamples)(clone);
    const entries = await readdir(join(clone, "examples"), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Write a scaffolded tree to `dir`, which must not exist or be empty unless
 * `replace` is set, when it replaces what is there. The files land in a
 * sibling folder first, so a failed write leaves no partial factory.
 */
export async function writeTree(
  dir: string,
  files: FileTree,
  { replace = false }: { replace?: boolean } = {},
): Promise<void> {
  const target = resolve(dir);
  const existing = await readdir(target).catch(() => null);
  if (existing && existing.length > 0 && !replace)
    throw new Error(`${target} is not empty`);
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(
    join(dirname(target), `.${basename(target)}-scaffold-`),
  );
  try {
    await materialize(staging, files);
    if (existing) await rm(target, { recursive: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function baseTree(
  template: Template,
  deps: ScaffoldDeps,
): Promise<FileTree> {
  switch (template.kind) {
    case "nakara": {
      // The bundled automations name this deployment's intake; the intake
      // choices generate the new factory's own.
      const files = await readTree(deps.nakaraDir ?? BUNDLED);
      for (const path of files.keys())
        if (path.startsWith("automations/")) files.delete(path);
      return files;
    }
    case "warp": {
      const example = template.example ?? DEFAULT_WARP_EXAMPLE;
      if (basename(example) !== example || example.startsWith("."))
        throw new Error(`"${example}" is not an example name`);
      const scratch = await mkdtemp(join(tmpdir(), "nakara-warp-"));
      try {
        const clone = join(scratch, "warp-factory-examples");
        await (deps.cloneWarpExamples ?? cloneWarpExamples)(clone);
        const dir = join(clone, "examples", example);
        if (!(await readdir(dir).catch(() => null)))
          throw new Error(`example "${example}" does not exist`);
        const files = await readTree(dir);
        // MIT: the copied files keep the license notice.
        files.set(WARP_LICENSE, await readFile(join(clone, "LICENSE"), "utf8"));
        return files;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    case "import": {
      const files = await readTree(template.from).catch(() => {
        throw new Error(`${template.from} is not a folder Nakara can read`);
      });
      if (!files.has("factory.yaml"))
        throw new Error(`${template.from} has no factory.yaml`);
      return files;
    }
    case "blank":
      return new Map([
        [
          "factory.yaml",
          stringify({
            schemaVersion: "v1alpha1",
            name: "blank",
            repositories: [],
            agentDefaults: { harness: { type: "claude" } },
          }),
        ],
        ["agents/foreman/agent.md", BLANK_FOREMAN],
      ]);
  }
}

/** Every file under `root`, except git metadata and symlinks. */
async function readTree(root: string): Promise<FileTree> {
  const files: FileTree = new Map();
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (entry.isFile())
        files.set(path, decode(await readFile(join(dir, entry.name))));
    }
  };
  await walk(root, "");
  return files;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
/** Text as a string, so the helpers below can edit it; anything else stays bytes. */
function decode(bytes: Uint8Array): string | Uint8Array {
  try {
    return UTF8.decode(bytes);
  } catch {
    return bytes;
  }
}

/** The text of a file; bytes and missing files read as empty. */
const textOf = (files: FileTree, path: string) => {
  const content = files.get(path);
  return typeof content === "string" ? content : "";
};

async function materialize(root: string, files: FileTree): Promise<void> {
  for (const [path, content] of files) {
    const target = join(root, path);
    if (!target.startsWith(`${root}/`)) throw new Error(`bad path ${path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

function applyFactory(
  files: FileTree,
  {
    slug,
    name,
    choices,
  }: { slug: string; name: string; choices: ScaffoldChoices },
): void {
  const doc = parseDocument(textOf(files, "factory.yaml"));
  if (doc.errors[0]) throw new Error(`factory.yaml: ${doc.errors[0].message}`);
  const before = doc.toJS() as { name?: unknown; alias?: unknown } | null;
  const oldAlias = String(before?.alias ?? before?.name ?? "");
  doc.set("name", slug);
  doc.set("alias", name);
  const description = choices.description?.trim();
  if (description) doc.set("description", description);
  doc.set(
    "repositories",
    choices.repositories.map((r) => ({ owner: r.owner, name: r.name })),
  );
  files.set("factory.yaml", doc.toString());
  if (oldAlias && oldAlias !== name)
    relabel(
      files,
      (label) => label === `factory:${oldAlias}`,
      `factory:${name}`,
    );
}

/**
 * Replace the trigger filter labels that `owned` matches with `to`, in a
 * list, a single label or `{ in: [...] }`; exclusions such as `not_in` stay.
 * GitHub intake polls a filter's labels instead of the factory's own.
 */
function relabel(
  files: FileTree,
  owned: (label: unknown) => boolean,
  to: string,
): void {
  // Replace each matching label where it stands, so the list keeps its style.
  const swap = (put: Put, at: string[], labels: unknown): void => {
    if (Array.isArray(labels))
      for (const [i, label] of labels.entries())
        swap(put, [...at, String(i)], label);
    else if (labels && typeof labels === "object" && "in" in labels)
      swap(put, [...at, "in"], labels.in);
    else if (owned(labels)) put(at, to);
  };
  for (const [path, text] of files) {
    if (typeof text !== "string" || !AUTOMATION.test(path)) continue;
    const { body } = splitFrontmatter(text);
    files.set(
      path,
      serializeMarkdown(text, body, (put, current) => {
        const triggers = current().triggers;
        if (!Array.isArray(triggers)) return;
        for (const [i, t] of triggers.entries()) {
          const labels = (t as Trigger | null)?.filter?.labels;
          swap(put, ["triggers", String(i), "filter", "labels"], labels);
        }
      }),
    );
  }
}

/**
 * Point a Warp example's GitHub trigger filters at this factory: `repos`
 * become the chosen repositories, and the labels that mark factory ownership
 * (`factory-ready`, `factory:*`) become its label. Routing labels such as
 * `needs-repro` stay.
 */
function adoptWarpFilters(
  files: FileTree,
  label: string,
  repositories: ScaffoldChoices["repositories"],
): void {
  const repos = repositories.map((r) => `${r.owner}/${r.name}`);
  const replace = (put: Put, at: string[], value: unknown, next: string[]) => {
    if (value === undefined || value === null) return;
    if (typeof value === "object" && !Array.isArray(value)) {
      if ("in" in value) put([...at, "in"], next);
    } else put(at, next);
  };
  for (const [path, text] of files) {
    if (typeof text !== "string" || !AUTOMATION.test(path)) continue;
    const { body } = splitFrontmatter(text);
    files.set(
      path,
      serializeMarkdown(text, body, (put, current) => {
        const triggers = current().triggers;
        if (!Array.isArray(triggers)) return;
        for (const [i, t] of triggers.entries()) {
          const filter = (t as Trigger | null)?.filter;
          const at = ["triggers", String(i), "filter"];
          replace(put, [...at, "repos"], filter?.repos, repos);
        }
      }),
    );
  }
  relabel(
    files,
    (l) =>
      typeof l === "string" &&
      (l === "factory-ready" || l.startsWith("factory:")),
    label,
  );
}

/** The agents/<name>/agent.md files with their declared type. */
function agentFiles(files: FileTree) {
  const found: { dir: string; path: string; type: string; text: string }[] = [];
  for (const [path, text] of files) {
    const match = /^(agents\/[^/]+)\/agent\.md$/.exec(path);
    if (!match?.[1] || typeof text !== "string") continue;
    const data = splitFrontmatter(text).data as Record<string, unknown>;
    const type = String(data.agentType ?? "CUSTOM");
    found.push({
      dir: match[1],
      path,
      type: type === "MAIN" ? "FOREMAN" : type,
      text,
    });
  }
  return found;
}

function applyAgents(
  files: FileTree,
  agents: NonNullable<ScaffoldChoices["agents"]>,
): void {
  const factory = parseDocument(textOf(files, "factory.yaml")).toJS() as {
    agentDefaults?: Parameters<typeof resolveHarness>[0];
  };
  const inherited = resolveHarness(
    factory.agentDefaults ?? {},
    HARNESS_FALLBACK,
  ).harness.kind;
  const disabled: string[] = [];
  for (const [role, choice] of Object.entries(agents)) {
    if (!choice) continue;
    const type = ROLE_TYPES[role as AgentRole];
    if (!type) throw new Error(`unknown agent "${role}"`);
    for (const agent of agentFiles(files).filter((a) => a.type === type)) {
      if (choice.enabled === false) {
        for (const path of [...files.keys()])
          if (path.startsWith(`${agent.dir}/`)) files.delete(path);
        if (!disabled.includes(role)) disabled.push(role);
        continue;
      }
      if (choice.harness)
        files.set(
          agent.path,
          withHarness(agent.text, choice.harness, inherited),
        );
    }
  }
  // The template's foreman prompt still describes the removed agents' steps.
  if (disabled.length === 0) return;
  for (const foreman of agentFiles(files).filter((a) => a.type === "FOREMAN")) {
    const { body } = splitFrontmatter(foreman.text);
    const note = `Disabled agents: ${disabled.join(", ")}; skip their steps.`;
    files.set(
      foreman.path,
      serializeMarkdown(foreman.text, `${body}\n\n${note}`, () => {}),
    );
  }
}

/** Point an agent.md at `harness`, keeping its model when the harness is unchanged. */
function withHarness(
  text: string,
  harness: HarnessChoice,
  inherited: string,
): string {
  const { body } = splitFrontmatter(text);
  return serializeMarkdown(text, body, (put, current) => {
    const fm = current() as Parameters<typeof resolveHarness>[0];
    const kind =
      fm.model || fm.harness
        ? resolveHarness(fm, HARNESS_FALLBACK).harness.kind
        : inherited;
    if (kind === harness) return;
    put(["model"], null);
    put(["harness"], { type: harness });
  });
}

type Trigger = {
  provider?: string;
  event?: string;
  filter?: { labels?: unknown; repos?: unknown };
};
const AUTOMATION = /^(automations\/[^/]+)\/automation\.md$/;

/** The automation folders whose every trigger is `provider`/`event` and passes `accept`. */
function automationsFor(
  files: FileTree,
  provider: string,
  event: string,
  accept: (t: Trigger) => boolean = () => true,
) {
  const dirs: string[] = [];
  for (const [path, text] of files) {
    if (typeof text !== "string") continue;
    const match = AUTOMATION.exec(path);
    if (!match?.[1]) continue;
    const triggers = (splitFrontmatter(text).data as { triggers?: unknown })
      .triggers;
    if (
      Array.isArray(triggers) &&
      triggers.length > 0 &&
      triggers.every(
        (t: Trigger) =>
          t?.provider === provider && t?.event === event && accept(t),
      )
    )
      dirs.push(match[1]);
  }
  return dirs;
}

function removeDirs(files: FileTree, dirs: string[]): void {
  for (const path of [...files.keys()])
    if (dirs.some((dir) => path.startsWith(`${dir}/`))) files.delete(path);
}

function applyIntake(
  files: FileTree,
  intake: NonNullable<ScaffoldChoices["intake"]>,
  label: string,
): void {
  const toggle = (
    on: boolean | undefined,
    provider: string,
    event: string,
    name: string,
    automation: string,
    accept?: (t: Trigger) => boolean,
  ) => {
    if (on === undefined) return;
    const existing = automationsFor(files, provider, event, accept);
    if (!on) removeDirs(files, existing);
    else if (existing.length === 0)
      files.set(`automations/${name}/automation.md`, automation);
  };
  toggle(
    intake.github,
    "github",
    "issue_labeled",
    "issue-labeled",
    ISSUE_LABELED,
    // Only an automation that polls the factory's label is its GitHub intake;
    // one routed by another label (`needs-repro`) is left alone.
    (t) => {
      const labels = filterList(t.filter?.labels);
      return !labels || labels.includes(label);
    },
  );
  toggle(
    intake.telegram,
    "telegram",
    "message",
    "telegram-request",
    TELEGRAM_REQUEST,
  );
  if (intake.schedule === null)
    removeDirs(files, automationsFor(files, "schedule", "cron_fired"));
  else if (intake.schedule) {
    const { cron, instructions } = intake.schedule;
    files.set(
      "automations/scheduled/automation.md",
      `---\n${stringify({
        displayName: "Scheduled run",
        triggers: [
          { provider: "schedule", event: "cron_fired", schedule: { cron } },
        ],
      })}---\n${instructions?.trim() || SCHEDULED}\n`,
    );
  }
}

/** Load the tree from a scratch copy; nothing is written where it will live. */
async function validate(files: FileTree): Promise<
  | {
      ok: true;
      warnings: Problem[];
      alias: string;
      description: string;
      claims: { repo: string; path: string }[];
    }
  | { ok: false; errors: Problem[]; warnings: Problem[] }
> {
  const scratch = await mkdtemp(join(tmpdir(), "nakara-scaffold-"));
  try {
    await materialize(scratch, files);
    const result = await loadDefinition(scratch, HARNESS_FALLBACK);
    if (!result.ok) return result;
    const { alias, factory } = result.definition;
    return {
      ok: true,
      warnings: result.warnings,
      alias,
      description: factory.description?.trim() ?? "",
      claims: repoClaims(result.definition),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const BLANK_FOREMAN = `---
description: Orchestrates the factory workflow.
agentType: FOREMAN
---
# Foreman

You are the orchestrator ("foreman") of the software factory. You accept work
into the factory and keep it in motion until it ends in a pull request that a
human reviews and merges. This factory has no other agents yet: do the work
yourself, ask the requester when the request is ambiguous, and never merge.
`;

const ISSUE_LABELED = `---
triggers:
  - provider: github
    event: issue_labeled
---
A GitHub issue was labeled for this factory. The issue is the work item and
already exists: adopt it instead of creating another one. Run the addressing
check, then follow the standard lifecycle. Updates are mirrored to the issue.
`;

const TELEGRAM_REQUEST = `---
displayName: Telegram request
triggers:
  - provider: telegram
    event: message
---
The operator sent this request from the trusted Telegram chat. Updates and
questions reach them there; they answer by replying. Run the addressing
check, then follow the standard lifecycle. When the work needs a tracking
issue, create one in the matching factory repository.
`;

const SCHEDULED = `A scheduled check with no requester waiting. Have one agent run the test
suite on the default branch of each factory repository. If everything
passes, complete the task with a one-line summary and no PR. If something
fails, open one GitHub issue per repository describing the failures (do not
add the factory label) and complete the task with the issue links.`;
