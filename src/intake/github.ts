// GitHub intake by polling through `gh` (inbound traffic only reaches this VPS
// through Cloudflare Tunnel, so webhooks are not assumed). Delivers:
// - github/issue_labeled: open issues carrying a trigger label become work items
//   of the factory whose trigger matched (by default its repositories and
//   its factory:<alias> label)
// - pull_request_merged / pull_request_closed for every factory PR
// - pr_feedback: reviews and comments on an open factory PR by people with
//   write access (orchestrator/pr-feedback.ts)
import { filterList } from "../definition/load.ts";
import type { Factory } from "../orchestrator/factory.ts";
import { PrFeedbackPoller } from "../orchestrator/pr-feedback.ts";
import { PullRequestGate } from "../orchestrator/pull-request-gate.ts";
import { run } from "../runner/workspace.ts";
import { hasWriteAccess } from "../runner/write-access.ts";

interface Issue {
  number: number;
  title: string;
  body: string;
  url: string;
  author: { login: string } | null;
}

const FACTORY_ISSUE = /<!-- nakara-item: \d+ -->/;

/** The last application of the label: who applied it, and when. */
interface Labeling {
  login: string;
  at: string;
}

/**
 * Who last applied the label: the Requester, who chose to use the factory.
 * Null when the events cannot be read or name no one, so the caller refuses
 * the issue: an issue author never stands in for the labeler.
 */
async function labeler(
  repo: string,
  issue: number,
  label: string,
): Promise<Labeling | null> {
  try {
    const out = await run(
      "gh",
      [
        "api",
        "--paginate",
        `repos/${repo}/issues/${issue}/events?per_page=100`,
        "--jq",
        '.[] | select(.event == "labeled") | "\\(.label.name)\\t\\(.actor.login // "")\\t\\(.created_at)"',
      ],
      undefined,
      60_000,
    );
    // GitHub label names compare case-insensitively.
    const last = out
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([name]) => name?.toLowerCase() === label.toLowerCase())
      .at(-1);
    return last?.[1] ? { login: last[1], at: last[2] ?? "" } : null;
  } catch {
    return null;
  }
}

/** One edit of an issue body, as GitHub keeps it. */
interface BodyEdit {
  login: string | null;
  at: string;
  diff: string | null;
}

/** The edits of an issue body made after `since`; throws when GitHub cannot be read. */
async function editsAfter(
  repo: string,
  issue: number,
  since: string,
): Promise<BodyEdit[]> {
  const [owner = "", name = ""] = repo.split("/");
  const out = await run(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      "query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { userContentEdits(first: 50) { nodes { createdAt diff editor { login } } } } } }",
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${issue}`,
      "--jq",
      ".data.repository.issue.userContentEdits.nodes",
    ],
    undefined,
    60_000,
  );
  const nodes = JSON.parse(out || "[]") as {
    createdAt: string;
    diff: string | null;
    editor: { login: string } | null;
  }[];
  return nodes
    .filter((n) => n.createdAt > since)
    .map((n) => ({
      login: n.editor?.login ?? null,
      at: n.createdAt,
      diff: n.diff,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** The Message that shows a Requester what changed in the request after labelling. */
function editNote(edits: BodyEdit[]): string {
  const shown = edits
    .map(
      (e) =>
        `Edited by @${e.login ?? "a deleted user"} at ${e.at}:\n${(e.diff ?? "(GitHub kept no diff of this edit)").slice(0, 2000)}`,
    )
    .join("\n\n");
  return `The request was changed by its Reporter after the label was applied. The item uses the edited text, so review the spec knowing it changed.\n\n${shown}`;
}

export class GithubPoller {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  get lastPoll(): { at: string; error: string | null } | null {
    const value = this.factory.store.getKv("github:lastPoll");
    return value ? JSON.parse(value) : null;
  }

  set lastPoll(value: { at: string; error: string | null } | null) {
    this.factory.store.setKv("github:lastPoll", JSON.stringify(value));
  }

  /** The factories whose repositories are polled, each for its own label. */
  readonly factories: Factory[];
  /** The first factory: its store, telemetry and pump are shared by the others. */
  readonly factory: Factory;
  /** Polls every factory's PRs: polling needs no factory's definition. */
  private readonly prs: PullRequestGate;
  /** Reads the human feedback on the same PRs, with each factory's agent token. */
  private readonly feedback: PrFeedbackPoller;
  constructor(factories: Factory | readonly Factory[]) {
    this.factories = Array.isArray(factories) ? [...factories] : [factories];
    // biome-ignore lint/style/noNonNullAssertion: A registry has at least one factory.
    this.factory = this.factories[0]!;
    this.prs = new PullRequestGate(
      this.factory.store,
      undefined,
      this.factory.telemetry.log,
    );
    this.feedback = new PrFeedbackPoller(
      this.factory.store,
      undefined,
      this.factory.telemetry.log,
    );
  }

  /** Poll a factory registered while Nakara runs, from the next poll on. */
  add(factory: Factory): void {
    if (!this.factories.includes(factory)) this.factories.push(factory);
  }

  /** Stop polling a deleted factory; the first factory, whose store all share, is never deleted. */
  remove(factory: Factory): void {
    const index = this.factories.indexOf(factory);
    if (index > 0) this.factories.splice(index, 1);
  }

  start(intervalSeconds: number): void {
    this.timer = setInterval(() => void this.poll(), intervalSeconds * 1000);
    void this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const errors: { factory: Factory; error: string }[] = [];
    try {
      for (const factory of this.factories)
        await this.intake(factory, (error) => errors.push({ factory, error }));
      await this.checkPullRequests().catch((e: unknown) =>
        errors.push({
          factory: this.factory,
          error: `pull requests: ${String(e)}`,
        }),
      );
    } finally {
      this.busy = false;
      const at = new Date();
      const named = this.factories.length > 1;
      this.lastPoll = {
        at: at.toISOString(),
        error: errors.length
          ? errors
              .map(({ factory, error }) =>
                named && factory.record
                  ? `${factory.record.slug}: ${error}`
                  : error,
              )
              .join("\n")
              .slice(0, 2000)
          : null,
      };
      const { metrics } = this.factory.telemetry;
      metrics.lastPoll.set({ source: "github" }, at.getTime() / 1000);
      metrics.pollErrors.inc({ source: "github" }, errors.length);
      for (const { factory, error } of errors)
        factory.telemetry.log.warn("intake.poll_failed", {
          source: "github",
          error,
        });
    }
  }

  /**
   * Import the labeled issues of one factory's GitHub triggers: by default
   * its own repositories with its own label (factory:<alias>), into it.
   */
  private async intake(
    factory: Factory,
    fail: (error: string) => void,
  ): Promise<void> {
    const def = factory.definition;
    if (!def) return;
    const factoryRepos = def.factory.repositories.map(
      (r) => `${r.owner}/${r.name}`,
    );
    for (const automation of def.automations) {
      if (!automation.frontmatter.enabled) continue;
      for (const trigger of automation.frontmatter.triggers) {
        if (trigger.provider !== "github" || trigger.event !== "issue_labeled")
          continue;
        const repos = filterList(trigger.filter?.repos) ?? factoryRepos;
        const labels = filterList(trigger.filter?.labels) ?? [def.label];
        // Bot labelers (GitHub Apps, templates) are refused unless named here.
        const bots = filterList(trigger.filter?.bots) ?? [];
        for (const repo of repos)
          for (const label of labels)
            await this.intakeLabeled(
              factory,
              repo,
              label,
              automation.name,
              bots,
            ).catch((e: unknown) => fail(`${repo} [${label}]: ${String(e)}`));
      }
    }
  }

  private async intakeLabeled(
    factory: Factory,
    repo: string,
    label: string,
    automation: string,
    bots: string[],
  ): Promise<void> {
    const out = await run(
      "gh",
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--label",
        label,
        "--json",
        "number,title,body,url,author",
        "--limit",
        "50",
      ],
      undefined,
      60_000,
    );
    const store = this.factory.store;
    for (const issue of JSON.parse(out || "[]") as Issue[]) {
      const ref = `github:${repo}#${issue.number}`;
      if (store.itemBySourceRef(ref)) continue;
      // Tracking issues the factory opens carry its label too; they are not new work.
      if (
        FACTORY_ISSUE.test(issue.body ?? "") ||
        store.itemByIssueUrl(issue.url)
      )
        continue;
      const labeling = await labeler(repo, issue.number, label);
      if (!labeling) {
        factory.telemetry.log.warn("intake.label_unreadable", {
          repo,
          issue: issue.number,
        });
        continue;
      }
      if (!(await this.mayLabel(factory, repo, issue.number, labeling, bots)))
        continue;
      let edits: BodyEdit[];
      try {
        edits = await this.editsWithoutWriteAccess(
          repo,
          issue.number,
          labeling.at,
        );
      } catch (error) {
        factory.telemetry.log.warn("intake.edits_unreadable", {
          repo,
          issue: issue.number,
          error: String(error),
        });
        continue;
      }
      const item = factory.createWorkItem({
        title: issue.title,
        request: issue.body || issue.title,
        requester: labeling.login,
        source: "github",
        sourceRef: ref,
        sourceUrl: issue.url,
        repo,
        automation,
        issueUrl: issue.url,
        requestEdited: edits.length > 0,
      });
      if (edits.length)
        this.factory.store.addMessage(item.id, "factory", editNote(edits));
    }
  }

  /**
   * The edits made to the issue after the label was applied by someone without
   * write access. A collaborator fixing a typo is not flagged; an editor whose
   * access cannot be read is. Throws when the edits cannot be read: the issue
   * is imported at a later poll rather than unchecked.
   */
  private async editsWithoutWriteAccess(
    repo: string,
    issue: number,
    since: string,
  ): Promise<BodyEdit[]> {
    const edits = await editsAfter(repo, issue, since);
    const writers = new Map<string, boolean | null>();
    const flagged: BodyEdit[] = [];
    for (const edit of edits) {
      if (edit.login && !writers.has(edit.login))
        writers.set(edit.login, await hasWriteAccess(repo, edit.login));
      if (!(edit.login && writers.get(edit.login))) flagged.push(edit);
    }
    return flagged;
  }

  /**
   * Whether the labeler may start work: write access to the repository, or a
   * bot the trigger names. A refusal is remembered with the label event it
   * judged, so the issue is judged again only when the label is applied again.
   */
  private async mayLabel(
    factory: Factory,
    repo: string,
    issue: number,
    { login, at }: Labeling,
    bots: string[],
  ): Promise<boolean> {
    const store = this.factory.store;
    const key = `github:refused:${repo}#${issue}`;
    const seen = `${login}@${at}`;
    if (store.getKv(key) === seen) return false;
    const allowed = login.endsWith("[bot]")
      ? bots.includes(login)
      : await hasWriteAccess(repo, login);
    if (allowed === null) {
      // GitHub could not say: refuse for now, and ask again next poll.
      factory.telemetry.log.warn("intake.label_unreadable", {
        repo,
        issue,
        login,
      });
      return false;
    }
    if (!allowed) {
      store.setKv(key, seen);
      factory.telemetry.log.info("intake.label_refused", {
        repo,
        issue,
        login,
      });
    }
    return allowed;
  }

  /** The slug of an item's factory, for its agent token; undefined for the default token. */
  private slugOf(factoryId: number): string | undefined {
    return this.factories.find((f) => f.record?.id === factoryId)?.record?.slug;
  }

  private async checkPullRequests(): Promise<void> {
    const failed: string[] = [];
    // One PR that cannot be read (a deleted repository, a gh error) must not
    // stop the check of the others.
    for (const { id, factory_id } of this.factory.store.itemsWithOpenPr())
      await this.prs
        .poll(id)
        .then((state) =>
          state === "OPEN"
            ? this.feedback.poll(id, this.slugOf(factory_id))
            : undefined,
        )
        .catch((error: unknown) => failed.push(`item ${id}: ${String(error)}`));
    void this.factory.pump();
    if (failed.length) throw new Error(failed.join("; "));
  }
}
