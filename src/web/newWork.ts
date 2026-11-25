import { z } from "zod";
import type { Store, WorkItem } from "../db.ts";
import type { Definition } from "../definition/load.ts";
import { run } from "../runner/workspace.ts";

export const DEFAULT_REQUESTER = "operator";

export interface NewWorkOptionsDto {
  /** False while no valid factory definition is loaded; nothing can be created. */
  ready: boolean;
  /** The label that sends a GitHub issue to this factory. */
  issueLabel: string | null;
  repositories: string[];
  automations: { name: string; label: string }[];
  defaults: {
    automation: string | null;
    budgetUsd: number;
    requester: string;
  };
  requesters: string[];
}

const manualAutomation = (definition: Definition | undefined) =>
  definition?.automations.find(
    (a) =>
      a.frontmatter.enabled &&
      a.frontmatter.triggers.some(
        (t) => t.provider === "nakara" && t.event === "manual",
      ),
  );

/** Choices and defaults for the New work form. Read-only. */
export function readNewWorkOptions(
  store: Store,
  definition: Definition | undefined,
): NewWorkOptionsDto {
  const requesters = new Set([DEFAULT_REQUESTER, ...store.requesters()]);
  return {
    ready: Boolean(definition),
    issueLabel: definition?.label ?? null,
    repositories:
      definition?.factory.repositories.map((r) => `${r.owner}/${r.name}`) ?? [],
    automations: (definition?.automations ?? [])
      .filter((a) => a.frontmatter.enabled)
      .map((a) => ({
        name: a.name,
        label: a.frontmatter.displayName || a.name,
      })),
    defaults: {
      automation: manualAutomation(definition)?.name ?? null,
      budgetUsd: store.defaultBudgetUsd,
      requester: DEFAULT_REQUESTER,
    },
    requesters: [...requesters],
  };
}

export const ISSUE_URL =
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/;

export const newWorkInput = z
  .object({
    title: z.string().trim().max(200).default(""),
    request: z.string().trim().default(""),
    issueUrl: z
      .string()
      .trim()
      .regex(
        ISSUE_URL,
        "Use a GitHub issue URL like https://github.com/owner/repo/issues/1",
      )
      .or(z.literal(""))
      .default(""),
    repo: z.string().nullable().default(null),
    automation: z.string().nullable().default(null),
    budgetUsd: z
      .number()
      .positive("The budget must be more than $0.")
      .max(10_000),
    requester: z.string().trim().min(1, "The requester is required.").max(100),
  })
  .refine((v) => v.issueUrl || (v.title && v.request), {
    message: "Enter a title and a request, or a GitHub issue URL to import.",
  });
export type NewWorkInput = z.infer<typeof newWorkInput>;

export interface GithubIssue {
  title: string;
  body: string;
  url: string;
}
export type FetchIssue = (url: string) => Promise<GithubIssue>;

export const fetchGithubIssue: FetchIssue = async (url) =>
  JSON.parse(
    await run(
      "gh",
      ["issue", "view", url, "--json", "title,body,url"],
      undefined,
      60_000,
    ),
  );

export type NewWorkResult =
  | { ok: true; item: WorkItem }
  | {
      ok: false;
      status: 409 | 502;
      error: { code: "policy" | "conflict" | "github"; message: string };
    };

const refuse = (
  status: 409 | 502,
  code: "policy" | "conflict" | "github",
  message: string,
): NewWorkResult => ({ ok: false, status, error: { code, message } });

/** Validate the choices against the loaded definition, import the issue if one is given, and create the item. */
export async function createNewWork(
  factory: {
    store: Store;
    definition: Definition | undefined;
    createWorkItem: (input: Parameters<Store["createItem"]>[0]) => WorkItem;
  },
  input: NewWorkInput,
  fetchIssue: FetchIssue,
): Promise<NewWorkResult> {
  const options = readNewWorkOptions(factory.store, factory.definition);
  if (!options.ready)
    return refuse(409, "policy", "No valid factory definition is loaded.");
  if (input.repo && !options.repositories.includes(input.repo))
    return refuse(
      409,
      "policy",
      `${input.repo} is not a repository of this factory.`,
    );
  if (
    input.automation &&
    !options.automations.some((a) => a.name === input.automation)
  )
    return refuse(
      409,
      "policy",
      `${input.automation} is not an enabled automation.`,
    );
  const common = {
    requester: input.requester,
    automation: input.automation,
    budgetUsd: input.budgetUsd,
  };
  const match = ISSUE_URL.exec(input.issueUrl);
  if (!match)
    return {
      ok: true,
      item: factory.createWorkItem({
        ...common,
        title: input.title,
        request: input.request,
        source: "manual",
        repo: input.repo,
      }),
    };

  const [, urlRepo = "", number] = match;
  // GitHub names are case-insensitive; keep the factory's spelling so the poller dedupes.
  const repo = options.repositories.find(
    (r) => r.toLowerCase() === urlRepo.toLowerCase(),
  );
  if (!repo)
    return refuse(
      409,
      "policy",
      `${urlRepo} is not a repository of this factory.`,
    );
  if (input.repo && input.repo !== repo)
    return refuse(
      409,
      "policy",
      `The issue belongs to ${repo}, not ${input.repo}.`,
    );
  const sourceRef = `github:${repo}#${number}`;
  const duplicate = (...urls: string[]) => {
    const existing =
      factory.store.itemBySourceRef(sourceRef) ??
      urls.map((u) => factory.store.itemByIssueUrl(u)).find(Boolean);
    return existing
      ? refuse(
          409,
          "conflict",
          `This issue is already work item #${existing.id}.`,
        )
      : null;
  };
  const canonicalUrl = `https://github.com/${repo}/issues/${number}`;
  const before = duplicate(canonicalUrl);
  if (before) return before;
  let issue: GithubIssue;
  try {
    issue = await fetchIssue(input.issueUrl);
  } catch (error) {
    return refuse(
      502,
      "github",
      `Could not read the issue: ${String(error).slice(0, 300)}`,
    );
  }
  // The poller may have imported the issue while gh was running.
  const after = duplicate(canonicalUrl, issue.url);
  if (after) return after;
  try {
    return {
      ok: true,
      item: factory.createWorkItem({
        ...common,
        title: issue.title,
        request: issue.body || issue.title,
        source: "github",
        sourceRef,
        sourceUrl: issue.url,
        issueUrl: issue.url,
        repo,
      }),
    };
  } catch (error) {
    // source_ref is UNIQUE: a concurrent import won between the check and the insert.
    const raced = duplicate(canonicalUrl, issue.url);
    if (raced) return raced;
    throw error;
  }
}
