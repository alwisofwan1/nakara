// Human feedback on a Work Item's Pull Request (Roadmap #23, phase 3): reviews
// that request changes or comment, inline review comments and plain PR
// comments, from people with write access, become one pr_feedback event that
// wakes the foreman. A login Nakara itself acts as is never feedback, except a
// shared identity (the Operator's own login) after the /nakara trigger
// (domain/nakara-trigger.ts); see PrFeedbackPoller.poll. Its state lives in kv under
// `pr-feedback:<item>`: the PR it was read from, the newest review and comment
// ids seen (feedback is what is newer) and those of reviews still pending,
// whether an event waits for a human_feedback follow_up, and the runs of the
// follow-ups that answer it until they end.
import type { Store } from "../db.ts";
import { afterTrigger } from "../domain/nakara-trigger.ts";
import {
  agentGhEnv,
  agentTokenOf,
  operatorGhEnv,
} from "../runner/agent-token.ts";
import { run } from "../runner/workspace.ts";
import { hasWriteAccess } from "../runner/write-access.ts";
import { type Logger, silentLogger } from "../telemetry/log.ts";

export const PR_FEEDBACK = "pr-feedback:";

/** One review or comment on the PR, as the poller reads it. */
export interface PrRemark {
  id: number;
  login: string | null;
  /** GitHub's account type: User, Bot, Organization. */
  type: string | null;
  body: string;
  url: string;
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state?: string;
  /** Inline comments only: the file and line it is on, and the review it belongs to. */
  path?: string | null;
  line?: number | null;
  review?: number | null;
}

export interface PrFeedbackRead {
  reviews: PrRemark[];
  /** Inline review comments (pulls/N/comments). */
  inline: PrRemark[];
  /** Plain PR comments (issues/N/comments). */
  comments: PrRemark[];
}

type Env = Record<string, string> | undefined;

/** GitHub as the feedback poller reads it; tests replace it. */
export interface PrFeedbackPort {
  read(repo: string, number: number, env: Env): Promise<PrFeedbackRead>;
  /** The login a token acts as. */
  login(env: Env): Promise<string>;
  writeAccess(repo: string, login: string, env: Env): Promise<boolean | null>;
}

const REMARK = "id, login: .user.login, type: .user.type, url: .html_url";

/** Every page of a list, one compact JSON object a line. */
async function list(path: string, fields: string, env: Env) {
  const out = await run(
    "gh",
    [
      "api",
      "--paginate",
      `${path}?per_page=100`,
      "--jq",
      `.[] | {${fields}} | @json`,
    ],
    undefined,
    60_000,
    env,
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PrRemark);
}

export const GH_PR_FEEDBACK: PrFeedbackPort = {
  async read(repo, number, env) {
    const [reviews, inline, comments] = await Promise.all([
      list(
        `repos/${repo}/pulls/${number}/reviews`,
        `${REMARK}, state, body: (.body // "")`,
        env,
      ),
      list(
        `repos/${repo}/pulls/${number}/comments`,
        `${REMARK}, body: (.body // ""), path, line: (.line // .original_line), review: .pull_request_review_id`,
        env,
      ),
      list(
        `repos/${repo}/issues/${number}/comments`,
        `${REMARK}, body: (.body // "")`,
        env,
      ),
    ]);
    return { reviews, inline, comments };
  },
  login: (env) =>
    run("gh", ["api", "user", "--jq", ".login"], undefined, 60_000, env),
  writeAccess: hasWriteAccess,
};

interface Cursor {
  /** The PR the ids belong to; another PR is read from its start. */
  pr: string;
  /** The newest id seen of each list: feedback is what is newer. */
  reviews: number;
  inline: number;
  comments: number;
  /**
   * Ids at or below their list's newest that were not feedback yet because
   * their review was still pending (unsubmitted); read again until it is.
   */
  waiting?: { reviews: number[]; inline: number[] };
  /** A pr_feedback event waits for a human_feedback follow_up. */
  open: boolean;
  /** The runs of the human_feedback follow-ups that answer it, until they end. */
  answering?: number[];
}

const readCursor = (store: Store, itemId: number): Cursor | null => {
  const value = store.getKv(PR_FEEDBACK + itemId);
  return value ? (JSON.parse(value) as Cursor) : null;
};

const writeCursor = (store: Store, itemId: number, cursor: Cursor) =>
  store.setKv(PR_FEEDBACK + itemId, JSON.stringify(cursor));

/**
 * How the follow-up run `runId` ended, following an interrupted run into the
 * run that resumes it: still going, answered (succeeded), or not (failed,
 * cancelled, stopped).
 */
function outcome(
  store: Store,
  runId: number,
): "running" | "answered" | "unanswered" {
  let run = store.runById(runId);
  while (run?.status === "interrupted") {
    // The interrupt records the run that resumes it (RunRepository.interruptRun).
    const resume = /Run #(\d+) continues it/.exec(run.error ?? "")?.[1];
    run = resume ? store.runById(Number(resume)) : undefined;
  }
  if (!run) return "unanswered";
  if (run.status === "queued" || run.status === "running") return "running";
  return run.status === "succeeded" ? "answered" : "unanswered";
}

/**
 * Whether PR feedback of the item waits for a human_feedback follow_up: a
 * pr_feedback event no follow-up took, or one whose follow-up ended without
 * answering it (failed, cancelled or stopped).
 */
export function prFeedbackOpen(store: Store, itemId: number): boolean {
  const cursor = readCursor(store, itemId);
  return (
    cursor?.open === true ||
    (cursor?.answering ?? []).some((id) => outcome(store, id) === "unanswered")
  );
}

/**
 * The human_feedback follow-up run `runId` takes the item's unanswered
 * feedback. It is in flight until the run ends: a run that does not succeed
 * leaves the feedback unanswered again. Feedback that arrives meanwhile opens
 * it again at once. Call inside the transaction that creates the run.
 */
export function answerPrFeedback(
  store: Store,
  itemId: number,
  runId: number,
): void {
  const cursor = readCursor(store, itemId);
  if (!cursor) return;
  writeCursor(store, itemId, {
    ...cursor,
    open: false,
    // This run answers what the ended ones did not; running ones stay tracked.
    answering: [
      ...(cursor.answering ?? []).filter(
        (id) => outcome(store, id) === "running",
      ),
      runId,
    ],
  });
}

const PR = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/;

/** What Nakara itself posts on a PR: evidence, and anything for a work item. */
const NAKARA_COMMENT = /<!-- nakara[:-]/;

/** The reviews that are feedback; an approval or a dismissal is not. */
const REVIEW_STATES = new Set(["CHANGES_REQUESTED", "COMMENTED"]);

const KINDS = ["reviews", "inline", "comments"] as const;
type Kind = (typeof KINDS)[number];

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;

/** The feedback as the foreman reads it in its turn, with what to do. */
export function feedbackPrompt(prUrl: string, read: PrFeedbackRead): string {
  const entries = [
    ...read.reviews.map((r) => ({
      head: `Review by @${r.login} (${r.state})`,
      r,
    })),
    ...read.inline.map((r) => ({
      head: `Inline comment by @${r.login}${r.path ? ` on \`${r.path}${r.line ? `:${r.line}` : ""}\`` : ""}`,
      r,
    })),
    ...read.comments.map((r) => ({ head: `Comment by @${r.login}`, r })),
  ];
  const bodies = entries.map(({ r }) =>
    r.body.trim() ? clip(r.body, 10_000) : "(no text after /nakara)",
  );
  // Longer than any backtick run in the feedback, so it cannot close the fence.
  const fence = "`".repeat(
    Math.max(
      3,
      ...bodies.flatMap((b) => (b.match(/`+/g) ?? []).map((m) => m.length + 1)),
    ),
  );
  return [
    `## Feedback on the pull request ${prUrl}`,
    "People with write access to the repository wrote this on the pull request since you last heard of it:",
    ...entries.map(({ head, r }, i) =>
      [`### ${head}: ${r.url}`, fence, bodies[i], fence].join("\n"),
    ),
    "Send this feedback to the implementation agent with follow_up and `human_feedback: true`. It does not count toward the revision cap; the budget and the run limit still apply. Ask the agent to answer a comment that needs a reply rather than a change with a reply on the pull request, in that comment's thread. After the revision the normal review and handoff rules apply: hand off again.",
  ].join("\n");
}

/**
 * Reads the feedback on the PRs of open Work Items, next to the PR gate's
 * poll and at its interval, with each factory's agent token.
 */
export class PrFeedbackPoller {
  private readonly store: Store;
  private readonly io: PrFeedbackPort;
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;
  /** The logins of the tokens Nakara acts with, by the variable holding each. */
  private readonly logins = new Map<string, string>();

  constructor(
    store: Store,
    io: PrFeedbackPort = GH_PR_FEEDBACK,
    log: Logger = silentLogger,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.store = store;
    this.io = io;
    this.log = log;
    this.env = env;
  }

  private async loginOf(variable: string, env: Env): Promise<string> {
    const known = this.logins.get(variable);
    if (known) return known;
    const login = (await this.io.login(env)).trim();
    if (!login) throw new Error(`no GitHub login for ${variable}`);
    this.logins.set(variable, login);
    return login;
  }

  /**
   * The identities Nakara acts as on GitHub: the factory's agent token (its
   * agents' replies, Nakara's own comments) and the foreman's token.
   */
  private async ownLogins(slug: string | undefined): Promise<Set<string>> {
    const variable = agentTokenOf(slug, this.env).variable ?? "gh";
    const own = new Set([
      await this.loginOf(variable, agentGhEnv(slug, this.env)),
    ]);
    const foreman = this.env.NAKARA_FOREMAN_GH_TOKEN;
    if (foreman)
      own.add(
        await this.loginOf("NAKARA_FOREMAN_GH_TOKEN", {
          GH_TOKEN: foreman,
          GITHUB_TOKEN: "",
        }),
      );
    return own;
  }

  /**
   * The Operator's login: the one gh acts as in Nakara's own environment
   * once every agent and foreman token is out of it (operatorGhEnv), so a
   * Nakara credential exported as GH_TOKEN or GITHUB_TOKEN never answers
   * for the Operator.
   */
  private operatorLogin(): Promise<string> {
    return this.loginOf("Operator", operatorGhEnv(this.env));
  }

  /**
   * Read the item's PR and turn new feedback into one pr_feedback event. The
   * first poll of an item only sets the cursor, so feedback from before is
   * not replayed. A review still pending, and the inline comments of one,
   * wait until it is submitted. A write access GitHub cannot tell throws and
   * moves nothing: the next poll reads the same feedback again.
   */
  async poll(itemId: number, slug: string | undefined): Promise<void> {
    const store = this.store;
    const item = store.item(itemId);
    const url = item?.pr_url;
    if (!item || !url || item.pr_merged) return;
    if (item.stage === "complete" || item.stage === "cancelled") return;
    const pr = PR.exec(url);
    if (!pr) return;
    const repo = pr[1] as string;
    const env = agentGhEnv(slug, this.env);
    const read = await this.io.read(repo, Number(pr[2]), env);
    const before = readCursor(store, itemId);
    const same = before?.pr === url;
    const since = same ? before : { reviews: 0, inline: 0, comments: 0 };
    const waited = {
      reviews: new Set(same ? (before.waiting?.reviews ?? []) : []),
      inline: new Set(same ? (before.waiting?.inline ?? []) : []),
    };
    const newest = (kind: Kind) =>
      Math.max(since[kind], ...read[kind].map((r) => r.id));
    // Not read yet: newer than the cursor, or waiting for its review.
    const unread = (kind: Kind, r: PrRemark) =>
      r.id > since[kind] || (kind !== "comments" && waited[kind].has(r.id));
    const pendingReviews = new Set(
      read.reviews.filter((r) => r.state === "PENDING").map((r) => r.id),
    );
    const pending = (kind: Kind, r: PrRemark) =>
      kind === "reviews"
        ? pendingReviews.has(r.id)
        : kind === "inline" && r.review != null && pendingReviews.has(r.review);
    const waiting = {
      reviews: read.reviews
        .filter(
          (r) => (!before || unread("reviews", r)) && pending("reviews", r),
        )
        .map((r) => r.id),
      inline: read.inline
        .filter((r) => (!before || unread("inline", r)) && pending("inline", r))
        .map((r) => r.id),
    };
    const fresh: PrFeedbackRead = { reviews: [], inline: [], comments: [] };
    if (before) {
      // What GitHub alone can rule out, before any identity or access is asked.
      const candidates = (kind: Kind) =>
        read[kind]
          .filter(
            (r) =>
              unread(kind, r) &&
              !pending(kind, r) &&
              r.login &&
              r.type !== "Bot" &&
              !r.login.endsWith("[bot]") &&
              r.body.trim() &&
              !NAKARA_COMMENT.test(r.body) &&
              (kind !== "reviews" || REVIEW_STATES.has(r.state ?? "")),
          )
          .sort((a, b) => a.id - b.id);
      const found = {
        reviews: candidates("reviews"),
        inline: candidates("inline"),
        comments: candidates("comments"),
      };
      if (KINDS.some((kind) => found[kind].length > 0)) {
        const own = await this.ownLogins(slug);
        const writers = new Map<string, boolean | null>();
        const writes = async (login: string) => {
          if (!writers.has(login))
            writers.set(login, await this.io.writeAccess(repo, login, env));
          const writer = writers.get(login);
          if (writer === null)
            throw new Error(`cannot read the write access of ${login}`);
          return writer === true;
        };
        // The feedback a remark carries, or null when it is none. A login
        // Nakara acts as (agent or foreman token) is shared when it is also
        // the Operator's login: a writer's comment and an agent's reply then
        // come from the same login and only /nakara tells them apart, so it
        // writes feedback only after /nakara. Any other login of Nakara's is
        // distinct, Nakara's alone, and never writes feedback, /nakara or
        // not: an agent that posts past the gh guard (curl, gh by its full
        // path, an MCP server) cannot start a revision loop. The Operator's
        // login is asked only for such a /nakara remark; when it cannot be
        // read the poll throws and moves nothing, so the remark is read again
        // next poll, neither dropped nor counted unchecked. The prefix alone
        // decides: a bare /nakara is feedback too, with no text after it.
        const feedback = async (
          r: PrRemark,
        ): Promise<{ body: string } | null> => {
          const login = r.login ?? "";
          const triggered = afterTrigger(r.body);
          if (own.has(login)) {
            if (triggered === null) return null;
            if (login !== (await this.operatorLogin())) return null;
          }
          if (!(await writes(login))) return null;
          return { body: triggered ?? r.body };
        };
        for (const kind of KINDS)
          for (const r of found[kind]) {
            const counted = await feedback(r);
            if (counted) fresh[kind].push({ ...r, body: counted.body });
          }
      }
    }
    const found = KINDS.some((kind) => fresh[kind].length > 0);
    store.transaction(() => {
      // The foreman may have recorded another PR, or the item closed, meanwhile.
      const now = store.item(itemId);
      if (
        !now ||
        now.pr_url !== url ||
        now.pr_merged ||
        now.stage === "complete" ||
        now.stage === "cancelled"
      )
        return;
      // A follow-up may have taken the feedback while GitHub was read.
      const current = readCursor(store, itemId);
      writeCursor(store, itemId, {
        pr: url,
        reviews: newest("reviews"),
        inline: newest("inline"),
        comments: newest("comments"),
        waiting,
        open: (current?.open ?? false) || found,
        ...(current?.answering?.length && { answering: current.answering }),
      });
      if (!found) return;
      const remark = (r: PrRemark) => ({
        author: r.login,
        body: r.body,
        url: r.url,
        ...(r.state && { state: r.state }),
        ...(r.path && { path: r.path }),
        ...(r.line && { line: r.line }),
      });
      store.addEvent(itemId, "pr_feedback", {
        prUrl: url,
        authors: [
          ...new Set(KINDS.flatMap((k) => fresh[k].map((r) => r.login))),
        ],
        reviews: fresh.reviews.map(remark),
        inline: fresh.inline.map(remark),
        comments: fresh.comments.map(remark),
        prompt: feedbackPrompt(url, fresh),
      });
      // An item at handoff waits for the human; their feedback wakes it.
      if (now.status === "waiting_human")
        store.updateItem(itemId, { status: "active" });
      this.log.info("pr_feedback.received", {
        item_id: itemId,
        pr_url: url,
        count: KINDS.reduce((n, k) => n + fresh[k].length, 0),
      });
    });
  }
}
