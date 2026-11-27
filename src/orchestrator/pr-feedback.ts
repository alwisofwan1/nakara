// Human feedback on a Work Item's Pull Request (Roadmap #23, phase 3): reviews
// that request changes or comment, inline review comments and plain PR
// comments, from people with write access, become one pr_feedback event that
// wakes the foreman. Its state lives in kv under `pr-feedback:<item>`: the
// PR it was read from, the newest review and comment ids seen (feedback is
// what is newer), and whether an event waits for a human_feedback follow_up.
import type { Store } from "../db.ts";
import { agentGhEnv, agentTokenOf } from "../runner/agent-token.ts";
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
  /** Inline comments only: the file and line it is on. */
  path?: string | null;
  line?: number | null;
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
        `${REMARK}, body: (.body // ""), path, line: (.line // .original_line)`,
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
  reviews: number;
  inline: number;
  comments: number;
  /** A pr_feedback event waits for a human_feedback follow_up. */
  open: boolean;
}

const readCursor = (store: Store, itemId: number): Cursor | null => {
  const value = store.getKv(PR_FEEDBACK + itemId);
  return value ? (JSON.parse(value) as Cursor) : null;
};

const writeCursor = (store: Store, itemId: number, cursor: Cursor) =>
  store.setKv(PR_FEEDBACK + itemId, JSON.stringify(cursor));

/** Whether a pr_feedback event of the item waits for a human_feedback follow_up. */
export const prFeedbackOpen = (store: Store, itemId: number): boolean =>
  readCursor(store, itemId)?.open === true;

/** A human_feedback follow_up answered the item's pr_feedback events. */
export function answerPrFeedback(store: Store, itemId: number): void {
  const cursor = readCursor(store, itemId);
  if (cursor?.open) writeCursor(store, itemId, { ...cursor, open: false });
}

const PR = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/;

/** What Nakara itself posts on a PR: evidence, and anything for a work item. */
const NAKARA_COMMENT = /<!-- nakara[:-]/;

/** The reviews that are feedback; an approval or a dismissal is not. */
const REVIEW_STATES = new Set(["CHANGES_REQUESTED", "COMMENTED"]);

const KINDS = ["reviews", "inline", "comments"] as const;

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
  const bodies = entries.map(({ r }) => clip(r.body, 10_000));
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
   * The identities whose writing is never feedback: the factory's agent token
   * (its agents' replies, Nakara's own comments) and the foreman's token.
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
   * Read the item's PR and turn new feedback into one pr_feedback event. The
   * first poll of an item only sets the cursor, so feedback from before is
   * not replayed. A write access GitHub cannot tell throws and moves nothing:
   * the next poll reads the same feedback again.
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
    const since =
      before?.pr === url ? before : { reviews: 0, inline: 0, comments: 0 };
    const newest = (kind: (typeof KINDS)[number]) =>
      Math.max(since[kind], ...read[kind].map((r) => r.id));
    const cursor: Cursor = {
      pr: url,
      reviews: newest("reviews"),
      inline: newest("inline"),
      comments: newest("comments"),
      open: before?.open ?? false,
    };
    const fresh: PrFeedbackRead = { reviews: [], inline: [], comments: [] };
    if (before) {
      // What GitHub alone can rule out, before any identity or access is asked.
      const candidates = (kind: (typeof KINDS)[number]) =>
        read[kind]
          .filter(
            (r) =>
              r.id > since[kind] &&
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
        const counts = async ({ login }: PrRemark) => {
          if (!login || own.has(login)) return false;
          if (!writers.has(login))
            writers.set(login, await this.io.writeAccess(repo, login, env));
          const writer = writers.get(login);
          if (writer === null)
            throw new Error(`cannot read the write access of ${login}`);
          return writer === true;
        };
        for (const kind of KINDS)
          for (const r of found[kind]) if (await counts(r)) fresh[kind].push(r);
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
      writeCursor(store, itemId, { ...cursor, open: cursor.open || found });
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
