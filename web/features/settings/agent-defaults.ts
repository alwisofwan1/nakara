/** agentDefaults as factory.yaml writes them; harness null is the `model` shorthand. */
export interface AgentDefaultsForm {
  harness: string | null;
  model: string | null;
  effort: string | null;
  runner: string | null;
  idleTimeoutMinutes: number | null;
}

/** What a save sends: an omitted key keeps its value. */
export type AgentDefaultsEdit = Partial<AgentDefaultsForm>;

export const HARNESSES = [
  { harness: "claude", label: "Claude Code" },
  { harness: "codex", label: "Codex" },
  { harness: "qwen", label: "Qwen" },
] as const;
export type Harness = (typeof HARNESSES)[number]["harness"];

/**
 * The harness agents run on, as the loader resolves it: Warp's `claude-code`
 * and harnesses that run on Warp only are Claude Code, and the shorthand picks
 * Qwen for a qwen model.
 */
export function harnessOf(form: AgentDefaultsForm): Harness {
  if (form.harness === "codex" || form.harness === "qwen") return form.harness;
  if (form.harness === null && form.model?.toLowerCase().startsWith("qwen"))
    return "qwen";
  return "claude";
}

/**
 * The keys of `draft` that differ from `saved`; null when nothing does.
 * Harness, model and effort travel together, as the server writes them. A
 * Claude Code model on a file that uses the `model` shorthand stays shorthand.
 */
export function agentDefaultsEdit(
  saved: AgentDefaultsForm,
  draft: AgentDefaultsForm,
): AgentDefaultsEdit | null {
  const edit: AgentDefaultsEdit = {};
  const shorthand =
    saved.harness === null &&
    draft.harness === "claude" &&
    draft.model !== null &&
    draft.effort === null;
  const choice = {
    harness: shorthand ? null : draft.harness,
    model: draft.model,
    effort: draft.effort,
  };
  if (
    choice.harness !== saved.harness ||
    choice.model !== saved.model ||
    choice.effort !== saved.effort
  )
    Object.assign(edit, choice);
  if (draft.runner !== saved.runner) edit.runner = draft.runner;
  if (draft.idleTimeoutMinutes !== saved.idleTimeoutMinutes)
    edit.idleTimeoutMinutes = draft.idleTimeoutMinutes;
  return Object.keys(edit).length ? edit : null;
}

export interface RunnerOption {
  name: string;
  sandbox: boolean;
}

/**
 * The runner to write for Docker sandbox or Host: the current one when it is
 * of that kind, else the first of that kind. Host without a runner file is no
 * runner (null), which runs on the host too.
 */
export function runnerFor(
  sandbox: boolean,
  current: string | null,
  runners: RunnerOption[],
): string | null {
  const kind = runners.filter((r) => r.sandbox === sandbox);
  if (kind.some((r) => r.name === current)) return current;
  return kind[0]?.name ?? null;
}

/** Whether `runner` runs agents in a container; no runner, or an unknown one, is the host. */
export const isSandbox = (runner: string | null, runners: RunnerOption[]) =>
  runners.some((r) => r.name === runner && r.sandbox);

/**
 * Runs saves of one file one after another, each with the revision the save
 * before it returned, so back-to-back saves never send the revision a
 * refetch has not replaced yet. One queue serves every editor of the file.
 *
 * `seen` offers a revision loaded from the server. A write-returned revision
 * stays authoritative: while a save is queued or running the offer is
 * ignored, and so is a revision a save already wrote past, which only a
 * refetch that started before that save can bring. Any other revision is a
 * change made elsewhere (another tab) and is taken.
 */
export function revisionQueue(initial: string) {
  let revision = initial;
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();
  /** Revisions a save here replaced. */
  const replaced = new Set<string>();
  return {
    get revision() {
      return revision;
    },
    seen(next: string) {
      if (pending > 0 || replaced.has(next)) return;
      revision = next;
    },
    run<T extends { revision: string }>(
      save: (revision: string) => Promise<T>,
    ): Promise<T> {
      pending++;
      const run = queue
        .then(async () => {
          const sent = revision;
          const result = await save(sent);
          if (result.revision !== sent) replaced.add(sent);
          // A save that writes the file back to an earlier text makes that revision current again.
          replaced.delete(result.revision);
          revision = result.revision;
          return result;
        })
        .finally(() => {
          pending--;
        });
      queue = run.catch(() => {});
      return run;
    },
  };
}

export type RevisionQueue = ReturnType<typeof revisionQueue>;
