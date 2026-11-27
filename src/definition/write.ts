import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  Document,
  isMap,
  isScalar,
  parseDocument,
  stringify,
  visit,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

import type { AgentType } from "../domain/policy.ts";
import { parseCron } from "../intake/schedule.ts";

import {
  FRONTMATTER,
  fileRevision,
  loadDefinition,
  type Problem,
  type ResolvedHarness,
} from "./load.ts";

/** The editable settings of an agent.md; null removes the key so the default applies. */
export interface AgentEdit {
  description: string | null;
  /** A harness type writes `harness:`; without one, `model` is Warp's shorthand. */
  harness: string | null;
  model: string | null;
  /** Written as `harness.reasoningLevel`, so it needs an explicit harness. */
  effort: string | null;
  runner: string | null;
  spawnableBy: string[] | null;
  idleTimeoutMinutes: number | null;
  /** The markdown body. */
  prompt: string;
}

/** A new agent: its folder name, its type and what it is told. */
export interface NewAgent {
  name: string;
  type: AgentType;
  description: string | null;
  prompt: string;
}

/**
 * A new agent's folder name: lowercase letters, digits, `-` and `_`, starting
 * with a letter or digit. `new` is the path of the web form.
 */
export const AGENT_NAME = /^(?!new$)[a-z0-9][a-z0-9_-]{0,62}$/;

export type WriteResult =
  | {
      ok: true;
      changed: boolean;
      warnings: Problem[];
      /** fileRevision of the file as written, when one file was edited. */
      revision?: string;
    }
  | { ok: false; code: "invalid"; errors: Problem[]; warnings: Problem[] }
  | { ok: false; code: "conflict"; message: string };

/** The one trigger of an automation, as the drawer edits it. */
export type TriggerEdit =
  | { kind: "github_label"; label: string }
  | { kind: "schedule"; cron: string }
  | { kind: "slack"; members: string[] }
  | { kind: "telegram" };

/** The editable parts of an automation.md; an omitted optional field keeps its value. */
export interface AutomationEdit {
  enabled: boolean;
  /** The markdown body. */
  instructions: string;
  /** Empty or null removes `displayName`, so the folder name shows. */
  displayName?: string | null | undefined;
  /** The agent the work item starts with; the loader checks that it exists. */
  agent?: string | undefined;
  /** Replaces `triggers` with exactly this one; refused when the file has several. */
  trigger?: TriggerEdit | undefined;
}

/** The provider and event of each trigger kind, as the intakes match them. */
const TRIGGER_EVENTS = {
  github_label: { provider: "github", event: "issue_labeled" },
  schedule: { provider: "schedule", event: "cron_fired" },
  slack: { provider: "slack", event: "message" },
  telegram: { provider: "telegram", event: "message" },
} as const;

/** Where each trigger kind keeps its value, and the value as written. */
function triggerValue(edit: TriggerEdit): [string, string, unknown] | null {
  switch (edit.kind) {
    case "github_label": {
      const label = edit.label.trim();
      if (!label)
        throw new Error("triggers: a GitHub label trigger needs a label");
      return ["filter", "labels", [label]];
    }
    case "schedule":
      // Throws the loader's own message for an invalid schedule.
      parseCron(edit.cron);
      return ["schedule", "cron", edit.cron.trim()];
    case "slack":
      return [
        "filter",
        "members",
        [...new Set(edit.members.map((m) => m.trim()).filter(Boolean))],
      ];
    case "telegram":
      return null;
  }
}

/**
 * Write `edit` as the only trigger. A trigger of the same kind keeps its other
 * keys (repos, bots, a schedule name) and only gets the new value.
 */
function putTrigger(
  put: Put,
  current: () => Record<string, unknown>,
  edit: TriggerEdit,
): void {
  const triggers = current().triggers;
  if (Array.isArray(triggers) && triggers.length > 1)
    throw new Error(
      "triggers: this automation has several triggers; edit automation.md to change them",
    );
  const { provider, event } = TRIGGER_EVENTS[edit.kind];
  const value = triggerValue(edit);
  const existing = Array.isArray(triggers)
    ? (triggers[0] as Record<string, unknown> | undefined)
    : undefined;
  if (existing?.provider === provider && existing.event === event) {
    if (value) put(["triggers", "0", value[0], value[1]], value[2]);
    return;
  }
  put(
    ["triggers"],
    [
      {
        provider,
        event,
        ...(value && { [value[0]]: { [value[1]]: value[2] } }),
      },
    ],
  );
}

export type Put = (path: string[], value: unknown) => void;

/**
 * Apply frontmatter changes and a new body to the text of a Markdown definition
 * file. Frontmatter values, key order, unknown keys and comments are preserved,
 * but the frontmatter is re-serialized when a value changes, so its formatting
 * (indentation, blank lines, flow style) may be normalized. An unchanged body
 * keeps its bytes; the file's line ending is kept.
 */
export function serializeMarkdown(
  text: string,
  body: string,
  apply: (put: Put, current: () => Record<string, unknown>) => void,
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lf = text.replaceAll("\r\n", "\n");
  const match = FRONTMATTER.exec(lf);
  const rawBody = match ? (match[2] ?? "") : lf;
  const doc = parseDocument(match?.[1] ?? "");
  if (doc.errors[0]) throw new Error(doc.errors[0].message);
  const current = () => (doc.toJS() ?? {}) as Record<string, unknown>;
  let changed = false;
  const put: Put = (path, value) => {
    let node: unknown = current();
    for (const key of path)
      node = (node as Record<string, unknown> | undefined)?.[key];
    if (value === null || value === undefined) {
      if (node === undefined) return;
      doc.deleteIn(path);
    } else {
      if (isDeepStrictEqual(node, value)) return;
      doc.setIn(path, value);
    }
    changed = true;
  };
  apply(put, current);

  const trimmed = body.replaceAll("\r\n", "\n").trim();
  const nextBody =
    trimmed === rawBody.trim()
      ? rawBody
      : `${/^\s*/.exec(rawBody)?.[0]}${trimmed}\n`;
  const out = changed
    ? `---\n${doc.toString()}---\n${nextBody}`
    : `${lf.slice(0, lf.length - rawBody.length)}${nextBody}`;
  return eol === "\n" ? out : out.replaceAll("\n", eol);
}

/** A harness, model and reasoning effort, written together. */
interface ModelChoice {
  harness: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * Write `choice` under the map at `at`, keeping the schema's either/or: a
 * harness writes `harness:` and removes the `model` shorthand, no harness
 * writes the shorthand and removes `harness`. `harness` is the current value,
 * so keys the form does not edit (auth) are kept, or refused rather than lost.
 */
function putModel(
  put: Put,
  at: string[],
  harness: unknown,
  choice: ModelChoice,
  /** Names the shorthand and the file in the refusal. */
  shorthand: string,
  file: string,
): void {
  if (choice.harness) {
    put([...at, "model"], null);
    put([...at, "harness", "type"], choice.harness);
    put([...at, "harness", "model"], choice.model || null);
    put([...at, "harness", "reasoningLevel"], choice.effort || null);
    return;
  }
  if (choice.effort)
    throw new Error(
      "harness: an effort needs an explicit harness; choose one, or clear the effort",
    );
  const extra =
    harness && typeof harness === "object" && !Array.isArray(harness)
      ? Object.keys(harness).filter(
          (k) => k !== "type" && k !== "model" && k !== "reasoningLevel",
        )
      : [];
  if (extra.length)
    throw new Error(
      `harness: ${shorthand} would drop ${extra.join(", ")}; keep an explicit harness or remove ${extra.length > 1 ? "these keys" : "this key"} from ${file} first`,
    );
  put([...at, "harness"], null);
  put([...at, "model"], choice.model || null);
}

/** Apply `edit` to the text of an agent.md; see serializeMarkdown for what is kept. */
export function serializeAgent(text: string, edit: AgentEdit): string {
  return serializeMarkdown(text, edit.prompt, (put, current) => {
    put(["description"], edit.description || null);
    putModel(
      put,
      [],
      current().harness,
      edit,
      "the Default harness",
      "agent.md",
    );
    put(["runner"], edit.runner || null);
    put(["spawnableBy"], edit.spawnableBy);
    put(["idleTimeoutMinutes"], edit.idleTimeoutMinutes);
  });
}

/**
 * Apply `edit` to the text of an automation.md; see serializeMarkdown for what
 * is kept. `enabled` defaults to true, so a file without the key only gains it
 * when the automation is disabled.
 */
export function serializeAutomation(
  text: string,
  edit: AutomationEdit,
): string {
  return serializeMarkdown(text, edit.instructions, (put, current) => {
    if ((current().enabled ?? true) !== edit.enabled)
      put(["enabled"], edit.enabled);
    if (edit.displayName !== undefined)
      put(["displayName"], edit.displayName?.trim() || null);
    if (edit.agent !== undefined) put(["agent"], edit.agent);
    if (edit.trigger) putTrigger(put, current, edit.trigger);
  });
}

export const FACTORY_FILE = "factory.yaml";
/** The longest factory description Settings accepts. */
export const FACTORY_DESCRIPTION_MAX = 500;

/** The everyday agentDefaults of factory.yaml; an omitted key keeps its value, null removes it. */
export interface AgentDefaultsEdit {
  /**
   * With `model` and `effort`, one choice written by putModel: when `harness`
   * or `model` is given, an omitted one of the three is null. Exactly one of
   * `harness` and `model` stays, as the schema requires.
   */
  harness?: string | null | undefined;
  model?: string | null | undefined;
  effort?: string | null | undefined;
  /** Null removes it, so agents run on the host. */
  runner?: string | null | undefined;
  /** Null removes it, so agents wait the built-in 60 minutes. */
  idleTimeoutMinutes?: number | null | undefined;
}

/** The editable settings of factory.yaml; an omitted key keeps its value. */
export interface FactoryEdit {
  /** Null or blank removes `description`. */
  description?: string | null | undefined;
  /** `secrets`, `mcpServers` and any other key of agentDefaults are kept. */
  agentDefaults?: AgentDefaultsEdit | undefined;
}

/** A yaml value as the loader sees it; the document keeps integers as BigInt. */
const plain = (value: unknown): unknown =>
  typeof value === "bigint" ? Number(value) : value;

/**
 * Apply `edit` to the text of factory.yaml. Values, key order, unknown keys and
 * comments are kept, and so is the text of one-line flow collections the edit
 * leaves alone, though a changed file is re-serialized, so other formatting
 * may be normalized; an edit that changes nothing returns the text as it was.
 */
export function serializeFactory(text: string, edit: FactoryEdit): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // BigInt keeps long integers (e.g. Slack IDs) exact on re-serialization.
  const lf = text.replaceAll("\r\n", "\n");
  const doc = parseDocument(lf, { intAsBigInt: true });
  if (doc.errors[0]) throw new Error(doc.errors[0].message);
  const keepFlows = flowText(doc, lf);
  let changed = false;
  if (edit.description !== undefined) {
    const next = edit.description?.trim() || null;
    if (next === null) {
      if (doc.hasIn(["description"])) {
        doc.deleteIn(["description"]);
        changed = true;
      }
    } else if (doc.getIn(["description"]) !== next) {
      const items = isMap(doc.contents) ? doc.contents.items : [];
      const name = items.findIndex(
        (pair) => isScalar(pair.key) && pair.key.value === "name",
      );
      // A new description goes under the name, where Settings shows it.
      if (!doc.hasIn(["description"]) && name >= 0)
        items.splice(name + 1, 0, doc.createPair("description", next));
      else doc.setIn(["description"], next);
      changed = true;
    }
  }
  const defaults = edit.agentDefaults;
  if (defaults) {
    const put: Put = (path, value) => {
      const node = doc.getIn(path);
      if (value === null || value === undefined) {
        if (!doc.hasIn(path)) return;
        doc.deleteIn(path);
      } else {
        if (isDeepStrictEqual(plain(node), value)) return;
        doc.setIn(path, value);
      }
      changed = true;
    };
    const at = ["agentDefaults"];
    if (defaults.harness !== undefined || defaults.model !== undefined) {
      const harness = doc.getIn([...at, "harness"], true);
      putModel(
        put,
        at,
        isMap(harness) ? harness.toJSON() : harness,
        {
          harness: defaults.harness ?? null,
          model: defaults.model ?? null,
          effort: defaults.effort ?? null,
        },
        "a model without a harness",
        FACTORY_FILE,
      );
    } else if (defaults.effort !== undefined)
      throw new Error(
        "agentDefaults: an effort is saved with its harness and model",
      );
    if (defaults.runner !== undefined)
      put([...at, "runner"], defaults.runner || null);
    if (defaults.idleTimeoutMinutes !== undefined)
      put([...at, "idleTimeoutMinutes"], defaults.idleTimeoutMinutes);
  }
  if (!changed) return text;
  // lineWidth 0: never fold long lines the team wrote on one line.
  const out = keepFlows(doc.toString({ lineWidth: 0 }));
  return eol === "\n" ? out : out.replaceAll("\n", eol);
}

/** One flow collection as the yaml library writes it, without its comments. */
const flowString = (node: YAMLMap | YAMLSeq) => {
  const bare = node.clone();
  bare.comment = null;
  bare.commentBefore = null;
  return new Document(bare).toString({ lineWidth: 0 }).trimEnd();
};

/**
 * The text of each one-line flow collection (`[a, b]`, `{ k: v }`) of `doc`,
 * parsed from `text`. The function it returns puts it back into the re-serialized document
 * for each one an edit left alone, which the yaml library would respace.
 */
function flowText(doc: Document, text: string) {
  const flows = (each: (node: YAMLMap | YAMLSeq) => void) =>
    visit(doc, {
      Collection(_, node) {
        if (!node.flow) return;
        each(node);
        return visit.SKIP;
      },
    });
  const written = new Map<YAMLMap | YAMLSeq, { text: string; as: string }>();
  flows((node) => {
    const source = node.range && text.slice(node.range[0], node.range[1]);
    if (source && !/[\n#]/.test(source))
      written.set(node, { text: source, as: flowString(node) });
  });
  return (out: string) => {
    let at = 0;
    flows((node) => {
      const was = written.get(node);
      if (!was || flowString(node) !== was.as) return;
      const found = out.indexOf(was.as, at);
      if (found < 0) return;
      out = out.slice(0, found) + was.text + out.slice(found + was.as.length);
      at = found + was.text.length;
    });
    return out;
  };
}

/** agentDefaults as written in factory.yaml, for the Settings form. */
export interface AgentDefaultsForm {
  /** Null: the `model` shorthand, or no harness at all. */
  harness: string | null;
  model: string | null;
  effort: string | null;
  runner: string | null;
  idleTimeoutMinutes: number | null;
}

const text = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * The description, agentDefaults and revision of factory.yaml as it is on
 * disk, for the Settings editor; null when the file cannot be read.
 */
export async function readFactoryFile(root: string): Promise<{
  description: string | null;
  agentDefaults: AgentDefaultsForm;
  revision: string;
} | null> {
  const bytes = await readFile(join(root, FACTORY_FILE)).catch(() => null);
  if (!bytes) return null;
  const doc = parseDocument(bytes.toString("utf8"));
  const data = doc.errors.length ? {} : (doc.toJS() ?? {});
  const d = isRecord(data.agentDefaults) ? data.agentDefaults : {};
  const harness = isRecord(d.harness) ? d.harness : {};
  const idle = d.idleTimeoutMinutes;
  return {
    description: text(data.description),
    agentDefaults: {
      harness: text(harness.type),
      model: text(d.harness === undefined ? d.model : harness.model),
      effort: text(harness.reasoningLevel),
      runner: text(d.runner),
      idleTimeoutMinutes: typeof idle === "number" ? idle : null,
    },
    revision: fileRevision(bytes),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tracked = (p: string) =>
  stat(join(p, ".git")).then(
    () => true,
    () => false,
  );

/** Whether `dir` lies inside a git work tree, so edits show up as uncommitted changes. */
export async function isGitTracked(dir: string): Promise<boolean> {
  let current = resolve(dir);
  for (;;) {
    if (await tracked(current)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Write `edit` into agents/<name>/agent.md. `revision` is the fileRevision the
 * form was loaded from; a file changed since then is a conflict, never
 * overwritten. The edit lands in a temporary copy of the tree first and the loader
 * validates the copy; only a valid copy is swapped in, so a rejected edit leaves
 * every file untouched. An edit that changes nothing writes and validates nothing.
 */
export function writeAgent(
  root: string,
  name: string,
  edit: AgentEdit,
  revision: string,
  defaults: ResolvedHarness,
  /** Runs after validation, right before the swap; tests use it to race the file. */
  beforeSwap?: () => Promise<void>,
): Promise<WriteResult> {
  return writeTextFile(
    root,
    join("agents", name, "agent.md"),
    (text) => serializeAgent(text, edit),
    revision,
    defaults,
    beforeSwap,
  );
}

/**
 * Write `edit` into automations/<name>/automation.md, with the revision check,
 * validation and swap of writeAgent.
 */
export function writeAutomation(
  root: string,
  name: string,
  edit: AutomationEdit,
  revision: string,
  defaults: ResolvedHarness,
  beforeSwap?: () => Promise<void>,
): Promise<WriteResult> {
  return writeTextFile(
    root,
    join("automations", name, "automation.md"),
    (text) => serializeAutomation(text, edit),
    revision,
    defaults,
    beforeSwap,
  );
}

/**
 * Write `edit` into factory.yaml through the yaml Document API, so comments,
 * key order and unknown keys survive; revision check, validation and swap as
 * in writeAgent.
 */
export function writeFactoryFile(
  root: string,
  edit: FactoryEdit,
  revision: string,
  defaults: ResolvedHarness,
  beforeSwap?: () => Promise<void>,
): Promise<WriteResult> {
  return writeTextFile(
    root,
    FACTORY_FILE,
    (text) => serializeFactory(text, edit),
    revision,
    defaults,
    beforeSwap,
  );
}

/**
 * Replace the definition file at `relPath` with `serialize` of its text. A file
 * changed since `revision` is a conflict; the new text is validated in a copy
 * of the tree, then swapped in by a rename. Shared by every single-file edit.
 */
async function writeTextFile(
  root: string,
  relPath: string,
  serialize: (text: string) => string,
  revision: string,
  defaults: ResolvedHarness,
  beforeSwap?: () => Promise<void>,
): Promise<WriteResult> {
  const conflict = {
    ok: false as const,
    code: "conflict" as const,
    message: `${relPath} changed on disk after it was loaded; reload the definition and edit again`,
  };
  // Write through a symlinked file so the link stays a link.
  const real = await realpath(join(root, relPath)).catch(() => null);
  if (!real) return conflict;
  const original = await readFile(real);
  if (fileRevision(original) !== revision) return conflict;
  let text: string;
  try {
    text = serialize(original.toString("utf8"));
  } catch (error) {
    // Serializing is pure: whatever it throws is a problem with this edit.
    return {
      ok: false,
      code: "invalid",
      errors: [{ path: relPath, message: (error as Error).message }],
      warnings: [],
    };
  }
  if (text === original.toString("utf8"))
    return { ok: true, changed: false, warnings: [], revision };

  const checked = await validateChange(root, defaults, (copy) =>
    writeFile(join(copy, relPath), text),
  );
  if (!checked.ok) return checked;

  await beforeSwap?.();
  // Rename within the folder so a reader never sees a half-written file.
  const mode = await stat(real).then(
    (file) => file.mode & 0o7777,
    () => null,
  );
  if (mode === null) return conflict;
  const temp = join(dirname(real), `.${basename(real)}.${randomUUID()}.tmp`);
  let swapped = false;
  try {
    await writeFile(temp, text, { flag: "wx" });
    await chmod(temp, mode);
    if (fileRevision(await readFile(real)) !== revision) return conflict;
    await rename(temp, real);
    swapped = true;
  } finally {
    if (!swapped) await rm(temp, { force: true });
  }
  return {
    ok: true,
    changed: true,
    warnings: checked.warnings,
    revision: fileRevision(text),
  };
}

export const LEARNINGS_PATH = join("skills", "learnings", "SKILL.md");
export const LEARNING_MAX_LINES = 3;
export const LEARNING_MAX_CHARS = 200;
export const LEARNINGS_CAP = 50;

const LEARNINGS_HEADER = `---
name: learnings
description: Lessons from past corrections in this factory, each approved by the Operator.
---

# Learnings

Each line is a lesson from a mistake an agent made here before. Follow them.

`;

/** Throws when a proposal is not 1–3 short plain-text lines: the text came from an agent run. */
export function checkLearning(lines: string[]): string[] {
  const clean = lines.map((line) => line.trim());
  if (clean.length < 1 || clean.length > LEARNING_MAX_LINES)
    throw new Error(`a lesson is 1 to ${LEARNING_MAX_LINES} lines`);
  for (const line of clean) {
    if (!line) throw new Error("a lesson line is empty");
    if (line.length > LEARNING_MAX_CHARS)
      throw new Error(
        `a lesson line is at most ${LEARNING_MAX_CHARS} characters`,
      );
    // One list item each: no line breaks, headings, frontmatter fences or HTML.
    if (/[\r\n\u2028\u2029]|^(#|---|<)/.test(line))
      throw new Error("a lesson line is plain text on one line");
  }
  return clean;
}

/** Append lesson lines as list items; refused past LEARNINGS_CAP lessons in the file. */
export function serializeLearnings(text: string, lines: string[]): string {
  const added = checkLearning(lines);
  const count = text.split("\n").filter((l) => l.startsWith("- ")).length;
  if (count + added.length > LEARNINGS_CAP)
    throw new Error(
      `the learnings skill holds at most ${LEARNINGS_CAP} lessons; remove old ones first`,
    );
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${body}${added.map((line) => `- ${line}\n`).join("")}`;
}

/**
 * Append approved lessons to skills/learnings/SKILL.md, creating it on the
 * first lesson. The shared skill reaches every agent through its skills block.
 */
export async function appendLearning(
  root: string,
  lines: string[],
  defaults: ResolvedHarness,
): Promise<WriteResult> {
  try {
    // Before the file is created, so a refused first lesson leaves no file behind.
    checkLearning(lines);
  } catch (error) {
    return {
      ok: false,
      code: "invalid",
      errors: [{ path: LEARNINGS_PATH, message: (error as Error).message }],
      warnings: [],
    };
  }
  const path = join(root, LEARNINGS_PATH);
  await mkdir(dirname(path), { recursive: true });
  // wx: never overwrite a file someone created meanwhile.
  await writeFile(path, LEARNINGS_HEADER, { flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return writeTextFile(
    root,
    LEARNINGS_PATH,
    (text) => serializeLearnings(text, lines),
    fileRevision(await readFile(path)),
    defaults,
  );
}

/** The agent.md of a new agent: its description and type, then the prompt. */
export function serializeNewAgent(agent: Omit<NewAgent, "name">): string {
  const description = agent.description?.trim();
  const frontmatter = {
    ...(description && { description }),
    agentType: agent.type,
  };
  const prompt = agent.prompt.replaceAll("\r\n", "\n").trim();
  return `---\n${stringify(frontmatter)}---\n${prompt && `\n${prompt}\n`}`;
}

/**
 * Create agents/<name>/agent.md. An existing folder is a conflict and is never
 * touched; the new agent is validated with the whole tree before it is written.
 */
export function createAgent(
  root: string,
  agent: NewAgent,
  defaults: ResolvedHarness,
): Promise<WriteResult> {
  if (!AGENT_NAME.test(agent.name))
    return Promise.resolve(
      refused(
        join("agents", agent.name),
        "an agent name uses lowercase letters, digits, - and _, starts with a letter or digit, and is not new",
      ),
    );
  return createFile(
    root,
    join("agents", agent.name),
    "agent.md",
    serializeNewAgent(agent),
    defaults,
  );
}

/**
 * Delete the folder agents/<name> with its agent.md and skills. `revision` is the
 * fileRevision of the agent.md the page showed; a file changed since then is a
 * conflict. The deletion is refused with the loader's errors when the tree would
 * no longer load, for example without a foreman or with an automation that
 * names the agent.
 */
export function deleteAgent(
  root: string,
  name: string,
  revision: string,
  defaults: ResolvedHarness,
  /** Runs after validation, right before the deletion; tests use it to race the file. */
  beforeDelete?: () => Promise<void>,
): Promise<WriteResult> {
  return deleteFolder(
    root,
    "agents",
    name,
    "agent.md",
    revision,
    defaults,
    beforeDelete,
  );
}

/** A new automation: its folder name and the drawer's fields. */
export interface NewAutomation {
  name: string;
  /** Empty or null writes no `displayName`, so the folder name shows. */
  displayName: string | null;
  trigger: TriggerEdit;
  /** The agent the work item starts with; the loader checks that it exists. */
  agent: string;
  /** The markdown body. */
  instructions: string;
  enabled: boolean;
}

/**
 * A new automation's folder name: lowercase letters, digits, `-` and `_`,
 * starting with a letter or digit.
 */
export const AUTOMATION_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** The automation.md of a new automation; its trigger is written as the drawer's edit writes it. */
export function serializeNewAutomation(
  automation: Omit<NewAutomation, "name">,
): string {
  return serializeMarkdown("", automation.instructions, (put, current) => {
    put(["displayName"], automation.displayName?.trim() || null);
    put(["enabled"], automation.enabled);
    put(["agent"], automation.agent);
    putTrigger(put, current, automation.trigger);
  });
}

/**
 * Create automations/<name>/automation.md, as createAgent creates an agent: a
 * taken name is a conflict and the tree is validated with the new file first.
 */
export function createAutomation(
  root: string,
  automation: NewAutomation,
  defaults: ResolvedHarness,
): Promise<WriteResult> {
  const dir = join("automations", automation.name);
  if (!AUTOMATION_NAME.test(automation.name))
    return Promise.resolve(
      refused(
        dir,
        "an automation name uses lowercase letters, digits, - and _, and starts with a letter or digit",
      ),
    );
  let text: string;
  try {
    text = serializeNewAutomation(automation);
  } catch (error) {
    // Serializing is pure: whatever it throws is a problem with the new file.
    return Promise.resolve(
      refused(join(dir, "automation.md"), (error as Error).message),
    );
  }
  return createFile(root, dir, "automation.md", text, defaults);
}

/**
 * Delete the folder automations/<name>, with deleteAgent's revision check and
 * validation. The work items it created stay; its triggers stop with the reload.
 */
export function deleteAutomation(
  root: string,
  name: string,
  revision: string,
  defaults: ResolvedHarness,
  beforeDelete?: () => Promise<void>,
): Promise<WriteResult> {
  return deleteFolder(
    root,
    "automations",
    name,
    "automation.md",
    revision,
    defaults,
    beforeDelete,
  );
}

const refused = (path: string, message: string): WriteResult => ({
  ok: false,
  code: "invalid",
  errors: [{ path, message }],
  warnings: [],
});

/**
 * Create the folder `dir` holding `file`. An existing folder is a conflict and
 * is never touched; the tree is validated with the new file before it is written.
 */
async function createFile(
  root: string,
  dir: string,
  file: string,
  text: string,
  defaults: ResolvedHarness,
): Promise<WriteResult> {
  const relPath = join(dir, file);
  const conflict = {
    ok: false as const,
    code: "conflict" as const,
    message: `${dir} already exists; choose another name`,
  };
  const taken = await lstat(join(root, dir)).then(
    () => true,
    () => false,
  );
  if (taken) return conflict;
  const checked = await validateChange(root, defaults, async (copy) => {
    await mkdir(join(copy, dir), { recursive: true });
    await writeFile(join(copy, relPath), text);
  });
  if (!checked.ok) return checked;

  await mkdir(join(root, dirname(dir)), { recursive: true });
  // Not recursive: a folder created since the check above is a conflict.
  const created = await mkdir(join(root, dir)).then(
    () => true,
    () => false,
  );
  if (!created) return conflict;
  try {
    await writeFile(join(root, relPath), text, { flag: "wx" });
  } catch (error) {
    await rm(join(root, dir), { recursive: true, force: true });
    throw error;
  }
  return { ok: true, changed: true, warnings: checked.warnings };
}

/**
 * Delete the folder <kind>/<name> when its `file` still has `revision` and the
 * tree loads without it; otherwise a conflict or the loader's errors.
 */
async function deleteFolder(
  root: string,
  kind: string,
  name: string,
  file: string,
  revision: string,
  defaults: ResolvedHarness,
  beforeDelete?: () => Promise<void>,
): Promise<WriteResult> {
  const dir = join(kind, name);
  const relPath = join(dir, file);
  const conflict = {
    ok: false as const,
    code: "conflict" as const,
    message: `${relPath} changed on disk after it was loaded; reload the definition and try again`,
  };
  const current = () =>
    readFile(join(root, relPath)).then(
      (bytes) => fileRevision(bytes) === revision,
      () => false,
    );
  // Only a folder directly in <kind>/.
  if (basename(name) !== name || name === "." || name === "..") return conflict;
  if (!(await current())) return conflict;
  const checked = await validateChange(root, defaults, (copy) =>
    rm(join(copy, dir), { recursive: true }),
  );
  if (!checked.ok) return checked;
  await beforeDelete?.();
  if (!(await current())) return conflict;
  // A symlinked folder loses the link, not the files it points to.
  await rm(join(root, dir), { recursive: true });
  return { ok: true, changed: true, warnings: checked.warnings };
}

/**
 * Apply `change` to a temporary copy of the tree and load the copy, so a change
 * the loader rejects never touches the tree itself.
 */
async function validateChange(
  root: string,
  defaults: ResolvedHarness,
  change: (copy: string) => Promise<unknown>,
): Promise<{ ok: true; warnings: Problem[] } | (WriteResult & { ok: false })> {
  const scratch = await mkdtemp(join(tmpdir(), "nakara-definition-"));
  try {
    const copy = join(scratch, basename(resolve(root)));
    // Dereferenced, so writing the copy never writes through a link into the tree.
    await cp(root, copy, {
      recursive: true,
      dereference: true,
      filter: (source) => basename(source) !== ".git",
    });
    await change(copy);
    const result = await loadDefinition(copy, defaults);
    if (!result.ok)
      return {
        ok: false,
        code: "invalid",
        errors: result.errors,
        warnings: result.warnings,
      };
    return { ok: true, warnings: result.warnings };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
