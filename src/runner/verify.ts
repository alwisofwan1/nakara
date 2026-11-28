// Nakara runs a repository's `verify` commands itself (issue #65), on the
// pushed PR head: in a fresh checkout Nakara makes from the repository cache,
// beside the item's directory and never inside an agent mount, each command
// in a fresh container from the runner's image, behind the runner's egress
// allowlist, with no agent session, no agent token and no secrets. Never on
// the host: a runner without a `dockerImage`, or no Docker, means the verify
// could not run. The commands run in order and stop at the first failure.
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Definition } from "../definition/load.ts";
import { envSecrets, redact } from "../telemetry/log.ts";
import {
  DEFAULT_EGRESS_ALLOW,
  type Egress,
  ensureEgress,
  removeContainer,
  runLabels,
} from "./docker.ts";
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
  /** The implementation run after which Nakara verifies; names its containers and log. */
  runId: number;
  owner: string;
  name: string;
  /** The PR head to check out. */
  head: string;
  commands: string[];
  /** The runner whose image, egress and limits the containers get. */
  runner: string | undefined;
  /** For all the commands together. */
  timeoutMs: number;
  dirs: { workDir: string; repoCacheDir: string; dataDir: string };
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
 * commands after it did not run. error: the verify could not run (no runner
 * image, no Docker, no checkout, a timeout), which says nothing about the
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

/** One process (the docker CLI): its exit code; rejects when it cannot start. */
export type RunProcess = (p: {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  onOutput: (text: string) => void;
  /** Kills the process. */
  signal: AbortSignal;
}) => Promise<number | null>;

/** Docker as verify uses it; tests replace it. */
export interface VerifyDocker {
  /** The runner's egress network and proxy; throws without a usable Docker. */
  ensureEgress: (allow: string[], image: string) => Promise<Egress>;
  run: RunProcess;
  removeContainer: (name: string) => Promise<void>;
}

const spawnProcess: RunProcess = ({ cmd, args, env, onOutput, signal }) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = () => child.kill("SIGKILL");
    signal.addEventListener("abort", kill, { once: true });
    const onData = (chunk: Buffer) => onOutput(chunk.toString("utf8"));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      signal.removeEventListener("abort", kill);
      reject(e);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      resolve(code);
    });
  });

export const DOCKER: VerifyDocker = {
  ensureEgress,
  run: spawnProcess,
  removeContainer,
};

/** Keep this much of a command's output in memory, enough for TAIL_LINES long lines. */
const TAIL_BYTES = 256 * 1024;

const commandError = (error: unknown) =>
  String((error as { stderr?: string }).stderr || error)
    .trim()
    .slice(0, 1000);

/**
 * What the docker CLI itself may see of Nakara's environment: how to find
 * and reach Docker, nothing else. The container gets only what `-e` names.
 */
function dockerCliEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (
      value !== undefined &&
      (key === "PATH" || key === "HOME" || key.startsWith("DOCKER_")) &&
      !/TOKEN|SECRET|PASSWORD|API_KEY/.test(key)
    )
      env[key] = value;
  return env;
}

/** The container one verify command runs in. */
export interface VerifyContainer {
  image: string;
  name: string;
  /** The verify directory: the checkout and the container HOME, read-write. */
  root: string;
  /** The checkout, the working directory. */
  cwd: string;
  /** The repository cache the checkout borrows objects from, read-only. */
  cache: string;
  egress: Egress;
  shape?: { vcpus: number; memoryGb: number } | undefined;
  labels: Record<string, string>;
}

/** `docker run` for one command; the values in `-e` are no secrets, so they may be in argv. */
export function verifyDockerArgs(
  c: VerifyContainer,
  command: string,
): string[] {
  const env = {
    HOME: join(c.root, ".home"),
    HTTPS_PROXY: c.egress.proxy,
    https_proxy: c.egress.proxy,
    HTTP_PROXY: c.egress.proxy,
    http_proxy: c.egress.proxy,
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
    NODE_USE_ENV_PROXY: "1",
  };
  return [
    "run",
    "--rm",
    "--init",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--name",
    c.name,
    ...Object.entries(c.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "--network",
    c.egress.network,
    "--pids-limit",
    "4096",
    ...(c.shape
      ? ["--cpus", String(c.shape.vcpus), "--memory", `${c.shape.memoryGb}g`]
      : []),
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "-w",
    c.cwd,
    "-v",
    `${c.root}:${c.root}`,
    "-v",
    `${c.cache}:${c.cache}:ro`,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    c.image,
    "bash",
    "-lc",
    command,
  ];
}

export async function runVerify(
  job: VerifyJob,
  docker: VerifyDocker = DOCKER,
): Promise<VerifyOutcome> {
  const commands: VerifyCommand[] = [];
  const error = (reason: string): VerifyOutcome => ({
    status: "error",
    commands,
    reason,
  });
  if (!job.runner)
    return error(
      "no runner: Nakara runs verify commands only in a container. Name a runner with a dockerImage under the repository's `runner`, or give the implement agent one.",
    );
  const runnerFile = job.def.runners.get(job.runner);
  if (!runnerFile)
    return error(`the runner "${job.runner}" is not in the definition.`);
  const image = runnerFile.platform?.linux?.dockerImage;
  if (!image)
    return error(
      `the runner "${job.runner}" has no dockerImage, and Nakara runs verify commands only in a container, never on the host.`,
    );

  const log = await openInternal(job.logPath);
  const secrets = envSecrets();
  const write = (text: string) =>
    log.write(redact(text, secrets) as string).then(() => undefined);
  // Nakara's own directory for the checkout; the previous verify's goes first.
  const root = join(job.dirs.workDir, `item-${job.itemId}.verify`);
  try {
    await write(
      `# Verify of ${job.owner}/${job.name} at ${job.head} on ${job.runner} (${image})\n`,
    );
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, ".home"), { recursive: true });
    const path = join(root, job.name);
    let cache: string;
    try {
      cache = (
        await ensureBareClone(job.dirs.repoCacheDir, job.owner, job.name)
      ).path;
      // A head pushed after the fetch, or on a fork's branch, by its SHA.
      await run("git", ["cat-file", "-e", `${job.head}^{commit}`], cache).catch(
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
            cache,
          ),
      );
      await initFromCache(cache, path);
      await run("git", ["checkout", "--quiet", "--detach", job.head], path);
    } catch (e) {
      const reason = `could not check out ${job.head}: ${commandError(e)}`;
      await write(`${reason}\n`);
      return error(reason);
    }

    let egress: Egress;
    try {
      egress = await docker.ensureEgress(
        runnerFile.egress?.allow ?? DEFAULT_EGRESS_ALLOW,
        image,
      );
    } catch (e) {
      const reason = `Docker or the egress proxy of the ${job.runner} runner is not available: ${commandError(e)}`;
      await write(`${reason}\n`);
      return error(reason);
    }

    const deadline = Date.now() + job.timeoutMs;
    for (const [index, command] of job.commands.entries()) {
      await write(`\n$ ${command}\n`);
      const started = Date.now();
      const container: VerifyContainer = {
        image,
        name: `nakara-verify-${job.runId}-${index + 1}`,
        root,
        cwd: path,
        cache,
        egress,
        shape: runnerFile.instanceShape,
        labels: {
          ...runLabels(job.runId, job.dirs.dataDir),
          "nakara.verify": "1",
        },
      };
      const ran = await runOne(
        job,
        docker,
        container,
        command,
        deadline,
        write,
      );
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
            ran.output
              .replace(/\n$/, "")
              .split("\n")
              .slice(-TAIL_LINES)
              .join("\n"),
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
}

type Ran =
  | { kind: "exited"; code: number; output: string }
  | { kind: "error"; reason: string };

/** One command in its own container: its exit code and the end of its output, or why it could not finish. */
async function runOne(
  job: VerifyJob,
  docker: VerifyDocker,
  container: VerifyContainer,
  command: string,
  deadline: number,
  write: (text: string) => Promise<void>,
): Promise<Ran> {
  const remaining = deadline - Date.now();
  const minutes = Math.round(job.timeoutMs / 60_000);
  if (remaining <= 0)
    return {
      kind: "error",
      reason: `the verify timeout (${minutes} min) ran out before \`${command}\`.`,
    };
  let output = "";
  let writing = Promise.resolve();
  let stopped: string | null = null;
  const kill = new AbortController();
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = reason;
    kill.abort();
    // Killing the docker CLI leaves the container running.
    void docker.removeContainer(container.name);
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
  try {
    const code = await docker.run({
      cmd: "docker",
      args: verifyDockerArgs(container, command),
      env: dockerCliEnv(process.env),
      onOutput: (text) => {
        output = (output + text).slice(-TAIL_BYTES);
        writing = writing.then(() => write(text)).catch(() => undefined);
      },
      signal: kill.signal,
    });
    await writing;
    if (stopped) return { kind: "error", reason: stopped };
    // docker run exits 125 when the container itself could not start.
    if (code === 125)
      return {
        kind: "error",
        reason: `Docker could not start the ${job.runner} container: ${output.trim().split("\n").slice(-5).join(" ").slice(0, 500)}`,
      };
    return { kind: "exited", code: code ?? 1, output };
  } catch (e) {
    await writing;
    return {
      kind: "error",
      reason: `Docker is not available: could not start \`docker\`: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
    job.signal?.removeEventListener("abort", onAbort);
  }
}
