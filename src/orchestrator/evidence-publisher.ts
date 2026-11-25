// Posts an item's proof on its pull request: each screenshot is uploaded as a
// GitHub attachment (gh's token, the endpoint the web editor uses; on a private
// repository only people with access can open it) and one comment, marked so
// it is edited rather than repeated, lists each acceptance criterion with its
// screenshot. A later run's proof replaces the comment's content.
// Proof waits until the item has a PR; a sweep picks it up, so a restart or a
// failed upload only delays it.
import type { Evidence, Store } from "../db.ts";
import { run } from "../runner/workspace.ts";
import type { Logger } from "../telemetry/log.ts";

export const MARKER = "<!-- nakara:evidence -->";
const SWEEP_MS = 30_000;
/** A failing item waits this long before the next try. */
const BACKOFF_MS = 10 * 60_000;

export interface EvidenceGitHub {
  repoId(slug: string): Promise<number>;
  /** The attachment URL for a file uploaded to the repository. */
  upload(repoId: number, file: string): Promise<string>;
  /** The id of the issue comment whose body contains `marker`, if any. */
  findComment(
    slug: string,
    number: number,
    marker: string,
  ): Promise<number | null>;
  createComment(slug: string, number: number, body: string): Promise<void>;
  editComment(slug: string, id: number, body: string): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const GH_EVIDENCE: EvidenceGitHub = {
  repoId: async (slug) =>
    Number(
      await run(
        "gh",
        ["api", `repos/${slug}`, "--jq", ".id"],
        undefined,
        60_000,
      ),
    ),
  async upload(repoId, file) {
    const name = file.split("/").pop() ?? "proof.png";
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const query = new URLSearchParams({
      name,
      content_type: CONTENT_TYPES[ext] ?? "application/octet-stream",
      repository_id: String(repoId),
    });
    const out = await run(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `https://uploads.github.com/user-attachments/assets?${query}`,
        "-H",
        "Content-Type: application/octet-stream",
        "--input",
        file,
        "--jq",
        ".url",
      ],
      undefined,
      120_000,
    );
    if (!out.startsWith("https://github.com/user-attachments/assets/"))
      throw new Error("GitHub returned no attachment URL");
    return out;
  },
  async findComment(slug, number, marker) {
    const out = await run(
      "gh",
      [
        "api",
        "--paginate",
        `repos/${slug}/issues/${number}/comments`,
        "--jq",
        `.[] | select(.body | contains(${JSON.stringify(marker)})) | .id`,
      ],
      undefined,
      60_000,
    );
    const id = out.split("\n")[0];
    return id ? Number(id) : null;
  },
  async createComment(slug, number, body) {
    await run(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `repos/${slug}/issues/${number}/comments`,
        "-f",
        `body=${body}`,
      ],
      undefined,
      60_000,
    );
  },
  async editComment(slug, id, body) {
    await run(
      "gh",
      [
        "api",
        "-X",
        "PATCH",
        `repos/${slug}/issues/comments/${id}`,
        "-f",
        `body=${body}`,
      ],
      undefined,
      60_000,
    );
  },
};

const PR = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

/** The PR comment for one run's proof. */
export function evidenceComment(rows: Evidence[]): string {
  // Markdown in a criterion stays text; the alt text drops brackets.
  const text = (s: string) => s.replace(/[\\`*_[\]<>|#]/g, "\\$&");
  return [
    MARKER,
    "### Evidence",
    `Screenshots the implement agent took of the running change (run #${rows[0]?.run_id}), one per acceptance criterion. Posted by Nakara; a later run replaces them.`,
    ...rows.map(
      (r, i) =>
        `**${i + 1}. ${text(r.criterion)}**\n\n<img src="${r.github_url}" alt="Screenshot ${i + 1}" width="720">`,
    ),
  ].join("\n\n");
}

export class EvidencePublisher {
  private readonly store: Store;
  private readonly gh: EvidenceGitHub;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private readonly waitUntil = new Map<number, number>();

  constructor(store: Store, log: Logger, gh: EvidenceGitHub = GH_EVIDENCE) {
    this.store = store;
    this.log = log;
    this.gh = gh;
  }

  start(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    void this.sweep();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Post the latest proof of every item that has a PR and unposted proof. */
  async sweep(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const itemId of this.store.itemsWithUnpostedEvidence()) {
        if ((this.waitUntil.get(itemId) ?? 0) > now) continue;
        try {
          await this.publish(itemId);
          this.waitUntil.delete(itemId);
        } catch (error) {
          this.waitUntil.set(itemId, now + BACKOFF_MS);
          this.log.warn("evidence.post_failed", { item_id: itemId, error });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Upload the item's unposted proof and write the PR comment; nothing until it has a GitHub PR. */
  async publish(itemId: number): Promise<void> {
    const match = this.store.item(itemId)?.pr_url?.match(PR);
    if (!match) return;
    const [, slug, num] = match as unknown as [string, string, string];
    const rows = this.store.latestEvidence(itemId);
    const unposted = rows.filter((r) => !r.github_url);
    if (!unposted.length) return;
    const repoId = await this.gh.repoId(slug);
    for (const row of unposted) {
      row.github_url = await this.gh.upload(repoId, row.file);
      this.store.setEvidenceUrl(row.id, row.github_url);
    }
    const body = evidenceComment(rows);
    const existing = await this.gh.findComment(slug, Number(num), MARKER);
    if (existing === null) await this.gh.createComment(slug, Number(num), body);
    else await this.gh.editComment(slug, existing, body);
    this.log.info("evidence.posted", {
      item_id: itemId,
      screenshots: rows.length,
    });
  }
}
