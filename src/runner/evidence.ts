// Proof an implement run leaves in its workspace: screenshots under
// .nakara-proof/ and a proof.json that names the acceptance criterion each one
// proves. Nakara copies them out of the workspace so it can post them on the
// PR and in the item's Slack thread; the agent never hosts images itself.
// The workspace is written by the agent, so nothing in it is trusted: links,
// paths outside the directory, other file types and big files are refused.
import { constants } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

export const PROOF_DIR = ".nakara-proof";
/** Where a review run finds the item's latest proof: beside the clones, read-only. */
export const EVIDENCE_DIR = ".nakara-evidence";
/** Kept out of commits in every clone: the proof, and playwright-cli's session files. */
export const EXCLUDED = [`/${PROOF_DIR}/`, "/.playwright-cli/"];
const MANIFEST = "proof.json";
const TYPES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
/** GitHub's attachment limit for images. */
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PROOFS = 20;
const MAX_CRITERION = 300;

export interface Proof {
  criterion: string;
  /** Nakara's copy. */
  file: string;
}

/**
 * The proof `repoPath` holds when its proof.json was written at or after
 * `since` (an earlier one belongs to an earlier run), copied into `dest`, and
 * a line per entry that was refused.
 */
export async function collectProof(
  repoPath: string,
  since: number,
  dest: string,
): Promise<{ proofs: Proof[]; problems: string[] }> {
  const dir = join(repoPath, PROOF_DIR);
  const manifest = join(dir, MANIFEST);
  const stat = await lstat(manifest).catch(() => null);
  if (!stat?.isFile() || stat.mtimeMs < since)
    return { proofs: [], problems: [] };
  let entries: unknown;
  try {
    entries = JSON.parse(await readFile(manifest, "utf8"));
  } catch {
    return { proofs: [], problems: [`${PROOF_DIR}/${MANIFEST} is not JSON.`] };
  }
  if (!Array.isArray(entries))
    return {
      proofs: [],
      problems: [`${PROOF_DIR}/${MANIFEST} is not a list.`],
    };
  // The directory itself could be a link out of the workspace.
  const realDir = await realpath(dir);
  if (realDir !== join(await realpath(repoPath), PROOF_DIR))
    return { proofs: [], problems: [`${PROOF_DIR}/ is a link.`] };
  const proofs: Proof[] = [];
  const problems: string[] = [];
  for (const [i, entry] of entries.entries()) {
    const refuse = (why: string) =>
      problems.push(`Entry ${i + 1} of ${PROOF_DIR}/${MANIFEST}: ${why}`);
    if (proofs.length === MAX_PROOFS) {
      refuse(`only the first ${MAX_PROOFS} screenshots are kept.`);
      break;
    }
    const { criterion, screenshot } = (entry ?? {}) as Record<string, unknown>;
    if (typeof criterion !== "string" || !criterion.trim())
      refuse("needs a criterion.");
    else if (typeof screenshot !== "string" || !screenshot)
      refuse("needs a screenshot path.");
    else {
      const path = resolve(dir, screenshot);
      const inside = relative(realDir, path);
      const file = await lstat(path).catch(() => null);
      if (inside.startsWith("..") || inside.startsWith(sep) || !inside)
        refuse(`${screenshot} is outside ${PROOF_DIR}/.`);
      else if (!TYPES.has(extname(path).toLowerCase()))
        refuse(`${screenshot} is not a PNG, JPEG, WebP or GIF image.`);
      else if (!file?.isFile())
        refuse(`${screenshot} is missing or not a regular file.`);
      else if (file.size > MAX_BYTES)
        refuse(`${screenshot} is larger than 10 MB.`);
      // A parent directory could be a link out of the workspace.
      else if ((await realpath(path)) !== join(realDir, inside))
        refuse(`${screenshot} is reached through a link.`);
      else {
        await mkdir(dest, { recursive: true });
        const copy = join(dest, `${proofs.length + 1}-${basename(path)}`);
        await copyFile(path, copy);
        proofs.push({
          criterion: criterion.trim().slice(0, MAX_CRITERION),
          file: copy,
        });
      }
    }
  }
  return { proofs, problems };
}

/** Keep the proof and browser session files out of the clone's commits. */
export async function excludeProof(repoPath: string): Promise<void> {
  const info = join(repoPath, ".git", "info");
  const exclude = join(info, "exclude");
  const current = await readFile(exclude, "utf8").catch(() => "");
  const lines = new Set(current.split("\n"));
  const missing = EXCLUDED.filter((l) => !lines.has(l));
  if (!missing.length) return;
  await mkdir(info, { recursive: true });
  await appendFile(
    exclude,
    `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
}

/**
 * Replaces `dir` with a read-only copy of `proofs` (Nakara's own copies, from
 * the store), so a review run can open each image. The copy is disposable: the
 * store keeps the original, and a review that deletes or edits it changes nothing.
 * shortcut: files are 0444 but the directory is not a read-only mount, since a
 * 0555 directory would break removeWorkspace; upgrade if the copy must resist the agent.
 */
export async function stageEvidence(
  proofs: Proof[],
  dir: string,
): Promise<Proof[]> {
  await rm(dir, { recursive: true, force: true });
  if (!proofs.length) return [];
  // Exclusive creates: the root is agent-writable, so a planted link fails the staging instead of being followed.
  await mkdir(dir);
  const staged: Proof[] = [];
  for (const [i, p] of proofs.entries()) {
    const file = join(dir, `${i + 1}-${basename(p.file)}`);
    await copyFile(p.file, file, constants.COPYFILE_EXCL);
    await chmod(file, 0o444);
    staged.push({ criterion: p.criterion, file });
  }
  return staged;
}
