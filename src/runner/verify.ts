// Nakara runs a repository's `verify` commands itself (issue #65), on the
// pushed PR head: in a fresh checkout Nakara makes from the repository cache,
// beside the item's directory and never inside an agent mount, in a fresh
// container from the runner's image (on the host for a runner without one),
// with no agent session, no agent token and no secrets, behind the runner's
// egress allowlist. The commands run in order and stop at the first failure.
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Definition } from "../definition/load.ts";
import { envSecrets, redact } from "../telemetry/log.ts";
import {
  DEFAULT_EGRESS_ALLOW,
  type DockerSpec,
  dockerize,
  ensureEgress,
  removeContainer,
  runLabels,
} from "./docker.ts";
import { hostEnv } from "./env.ts";
import {
  ensureBareClone,
  initFromCache,
  openInternal,
  run,
} from "./workspace.ts";

/** The lines of a failing command's output the foreman reads. */
export const TAIL_LINES = 200;

export interface VerifyJob {
  def: Definition;
  itemId: number;
  /** The implementation run after which Nakara verifies; names its container and log. */
  runId: number;
  owner: string;
  name: string;
  /** The PR head to check out. */
  head: string;
  commands: string[];
  /** The runner the commands run on; undefined runs them on the host. */
  runner: string | undefined;
  /** For all the commands together. */
  timeoutMs: number;
  dirs: { workDir: string; repoCacheDir: string; dataDir: string };
  claudeBin: string;
  /** Where the full output goes, redacted; an internal file of the item. */
  logPath: string;
  signal?: AbortSignal | undefined;
}

export interface VerifyCommand {
  command: string;
  ok: boolean;
  durationMs: number;
}

/**
 * passed: every command exited 0. failed: `failed` exited non-zero, and the
 * commands after it did not run. error: the verify could not run (no runner,
 * no checkout, Docker unavailable, a timeout), which says nothing about the
 * change.
 */
export interface VerifyOutcome {
  status: "passed" | "failed" | "error";
  commands: VerifyCommand[];
  failed?: string;
  /** The last TAIL_LINES lines of the failing command's output, redacted. */
  tail?: string;
  reason?: string;
}

export type Verifier = (job: VerifyJob) => Promise<VerifyOutcome>;

/** Keep this much of a command's output in memory, enough for TAIL_LINES long lines. */
const TAIL_BYTES = 256 * 1024;

const commandError = (error: unknown) =>
  String((error as { stderr?: string }).stderr || error)
    .trim()
    .slice(0, 1000);

export const runVerify: Verifier = async (job) => {
  const commands: VerifyCommand[] = [];
  const error = (reason: string): VerifyOutcome => ({
    status: "error",
    commands,
    reason,
  });
  const runnerFile = job.runner ? job.def.runners.get(job.runner) : undefined;
  if (job.runner && !runnerFile)
    return error(`the runner "${job.runner}" is not in the definition.`);
  const image = runnerFile?.platform?.linux?.dockerImage;

  const log = await openInternal(job.logPath);
  const secrets = envSecrets();
  const write = (text: string) =>
    log.write(redact(text, secrets) as string).then(() => undefined);
  // Nakara's own directory for the checkout; the previous verify's goes first.
  const root = join(job.dirs.workDir, `item-${job.itemId}.verify`);
  try {
    await write(
      `# Verify of ${job.owner}/${job.name} at ${job.head} on ${image ? `${job.runner} (${image})` : "the host"}\n`,
    );
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    const path = join(root, job.name);
    let bare: string;
    try {
      bare = (await ensureBareClone(job.dirs.repoCacheDir, job.owner, job.name))
        .path;
      // A head pushed after the fetch, or on a fork's branch, by its SHA.
      await run("git", ["cat-file", "-e", `${job.head}^{commit}`], bare).catch(
        () =>
          run(
            "git",
            [
              "-c",
              "gc.pruneExpire=never",
              "fetch",
              "--quiet",
              "origin",
              job.head,
            ],
            bare,
          ),
      );
      await initFromCache(bare, path);
      await run("git", ["checkout", "--quiet", "--detach", job.head], path);
    } catch (e) {
      const reason = `could not check out ${job.head}: ${commandError(e)}`;
      await write(`${reason}\n`);
      return error(reason);
    }

    let docker: DockerSpec | undefined;
    if (image)
      try {
        docker = {
          image,
          mounts: [root],
          readOnly: [bare],
          shape: runnerFile?.instanceShape,
          home: join(root, ".home"),
          name: `nakara-verify-${job.runId}`,
          labels: runLabels(job.runId, job.dirs.dataDir),
          egress: await ensureEgress(
            runnerFile?.egress?.allow ?? DEFAULT_EGRESS_ALLOW,
            image,
          ),
        };
        await mkdir(docker.home, { recursive: true });
      } catch (e) {
        const reason = `the ${job.runner} runner is not available: ${commandError(e)}`;
        await write(`${reason}\n`);
        return error(reason);
      }

    const deadline = Date.now() + job.timeoutMs;
    for (const command of job.commands) {
      await write(`\n$ ${command}\n`);
      const started = Date.now();
      const ran = await runOne(job, docker, path, command, deadline, write);
      const durationMs = Date.now() - started;
      if (ran.kind === "error") {
        await write(`\n${ran.reason}\n`);
        return error(ran.reason);
      }
      const ok = ran.code === 0;
      commands.push({ command, ok, durationMs });
      await write(
        `\n[exit ${ran.code} after ${(durationMs / 1000).toFixed(1)} s]\n`,
      );
      if (!ok)
        return {
          status: "failed",
          commands,
          failed: command,
          tail: redact(
            ran.output.split("\n").slice(-TAIL_LINES).join("\n"),
            secrets,
          ) as string,
        };
    }
    return { status: "passed", commands };
  } catch (e) {
    return error(`Nakara error: ${commandError(e)}`);
  } finally {
    await log.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
};

type Ran =
  | { kind: "exited"; code: number; output: string }
  | { kind: "error"; reason: string };

/** One command: its exit code and the end of its output, or why it could not finish. */
function runOne(
  job: VerifyJob,
  docker: DockerSpec | undefined,
  cwd: string,
  command: string,
  deadline: number,
  write: (text: string) => Promise<void>,
): Promise<Ran> {
  const remaining = deadline - Date.now();
  const minutes = Math.round(job.timeoutMs / 60_000);
  if (remaining <= 0)
    return Promise.resolve({
      kind: "error",
      reason: `the verify timeout (${minutes} min) ran out before \`${command}\`.`,
    });
  // No agent token, no secrets: only what a shell needs, and the proxy in a container.
  const c = docker
    ? dockerize(docker, job.claudeBin, cwd, ["bash", "-lc", command], {})
    : {
        cmd: "bash",
        args: ["-lc", command],
        env: hostEnv(),
      };
  return new Promise<Ran>((resolve) => {
    let output = "";
    let writing = Promise.resolve();
    let ended: string | null = null;
    const child = spawn(c.cmd, c.args, {
      cwd: docker ? undefined : cwd,
      env: c.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-TAIL_BYTES);
      writing = writing.then(() => write(text)).catch(() => undefined);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const stop = (reason: string) => {
      if (ended) return;
      ended = reason;
      child.kill("SIGKILL");
      if (docker?.name) void removeContainer(docker.name);
    };
    const timer = setTimeout(
      () =>
        stop(
          `the verify timeout (${minutes} min) ran out during \`${command}\`.`,
        ),
      remaining,
    );
    const onAbort = () => stop(`the run was stopped during \`${command}\`.`);
    job.signal?.addEventListener("abort", onAbort, { once: true });
    if (job.signal?.aborted) onAbort();
    const finish = (ran: Ran) => {
      clearTimeout(timer);
      job.signal?.removeEventListener("abort", onAbort);
      void writing.then(() => resolve(ran));
    };
    child.on("error", (e) =>
      finish({
        kind: "error",
        reason: `could not start \`${c.cmd}\`: ${e.message}`,
      }),
    );
    child.on("close", (code) => {
      if (ended) return finish({ kind: "error", reason: ended });
      // docker run exits 125 when the container itself could not start.
      if (docker && code === 125)
        return finish({
          kind: "error",
          reason: `Docker could not start the ${job.runner} container: ${output.trim().split("\n").slice(-5).join(" ").slice(0, 500)}`,
        });
      finish({ kind: "exited", code: code ?? 1, output });
    });
  });
}
