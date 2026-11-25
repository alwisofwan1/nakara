import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { DEFAULT_MAX_RUNS } from "./domain/policy.ts";
import { LEVELS } from "./telemetry/log.ts";

const num = (fallback: number) =>
  z.coerce.number().positive().default(fallback);

const env = z.object({
  /** Comma-separated extra Host header values (host:port) the web server answers to, e.g. a dev proxy. */
  NAKARA_ALLOWED_HOSTS: z.string().default(""),
  NAKARA_HOST: z.string().default("127.0.0.1"),
  NAKARA_PORT: z.coerce.number().int().min(1).max(65535).default(7788),
  /** Prefix for generated links when served behind a path proxy, e.g. /proxy/7788. */
  NAKARA_BASE_PATH: z
    .string()
    .default("")
    .transform((p) => p.replace(/\/+$/, "")),
  /** External URL of the web UI, base path included, for links in notifications. */
  NAKARA_PUBLIC_URL: z
    .string()
    .default("")
    .transform((u) => u.replace(/\/+$/, "")),
  // Under `node --test` the default is a throwaway dir: a test that starts a
  // factory sweeps the containers labelled with its data dir, and the real
  // one's are those of the running Nakara.
  NAKARA_DATA_DIR: z
    .string()
    .default(
      process.env.NODE_TEST_CONTEXT
        ? join(tmpdir(), `nakara-test-${process.pid}`)
        : join(homedir(), ".local/share/nakara"),
    ),
  NAKARA_DEFINITION_DIR: z.string().default("factory"),
  /** Comma-separated peer IPs (besides loopback) allowed to reach the web UI. */
  NAKARA_ALLOW: z.string().default(""),
  NAKARA_CLAUDE_BIN: z.string().default("claude"),
  NAKARA_QWEN_BIN: z.string().default("claude-qwen"),
  NAKARA_CODEX_BIN: z.string().default("codex"),
  /** Log in once with `CODEX_HOME=<this> codex login --device-auth`. */
  NAKARA_CODEX_HOME: z
    .string()
    .default(join(homedir(), ".config/nakara/codex")),
  NAKARA_BUDGET_USD: num(15),
  NAKARA_MAX_REVIEWS: num(1),
  NAKARA_MAX_REVISIONS: num(2),
  /** Runs a work item may start: foreman turns and agent runs, failed and interrupted ones included. */
  NAKARA_MAX_RUNS: z.coerce.number().int().min(1).default(DEFAULT_MAX_RUNS),
  NAKARA_CONCURRENCY: num(2),
  NAKARA_POLL_SECONDS: num(60),
  /** Safety-net scheduler interval; the scheduler also runs after every state change. */
  NAKARA_PUMP_SECONDS: num(15),
  /**
   * On SIGTERM, how long runs in flight get to finish before they are
   * interrupted and resumed after the restart. Keep the unit's TimeoutStopSec
   * above it. 0 interrupts at once.
   */
  NAKARA_DRAIN_SECONDS: z.coerce.number().min(0).default(600),
  /** Snapshots of nakara.db; default `<data dir>/backups`. */
  NAKARA_BACKUP_DIR: z.string().default(""),
  /** At least one minute, so a typo cannot snapshot in a tight loop. */
  NAKARA_BACKUP_INTERVAL_HOURS: z.coerce
    .number()
    .min(1 / 60)
    .default(24),
  NAKARA_BACKUP_KEEP: z.coerce.number().int().min(1).default(14),
  /** Mirror foreman updates as comments on the source GitHub issue. */
  NAKARA_GITHUB_MIRROR: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Bot from @BotFather; notifications and replies go through long polling, no webhook. */
  NAKARA_TELEGRAM_BOT_TOKEN: z.string().default(""),
  /** The only chat the bot listens to. Unset: the bot logs the chat ids that message it. */
  NAKARA_TELEGRAM_CHAT_ID: z.string().default(""),
  /**
   * Kill switch for the Slack bridge. Its tokens (NAKARA_SLACK_BOT_TOKEN,
   * NAKARA_SLACK_APP_TOKEN) live in the secret store, not here.
   */
  NAKARA_SLACK_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Dotenv file of agent secrets, mode 600; default `<data dir>/secrets.env`. */
  NAKARA_SECRETS_FILE: z.string().default(""),
  /** Least severe level written to the JSON log on stdout. */
  NAKARA_LOG_LEVEL: z.enum(LEVELS).default("info"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const e = env.parse(source);
  const dataDir = resolve(e.NAKARA_DATA_DIR);
  return {
    host: e.NAKARA_HOST,
    port: e.NAKARA_PORT,
    basePath: e.NAKARA_BASE_PATH,
    publicUrl: e.NAKARA_PUBLIC_URL,
    dataDir,
    dbPath: join(dataDir, "nakara.db"),
    tokenPath: join(dataDir, "token"),
    secretsPath: e.NAKARA_SECRETS_FILE
      ? resolve(e.NAKARA_SECRETS_FILE)
      : join(dataDir, "secrets.env"),
    workDir: join(dataDir, "work"),
    repoCacheDir: join(dataDir, "repos"),
    definitionDir: resolve(e.NAKARA_DEFINITION_DIR),
    /** NAKARA_DEFINITION_DIR was set rather than defaulted; see FactoryRegistry.definitionDirMismatch(). */
    definitionDirSet: Boolean(source.NAKARA_DEFINITION_DIR),
    allowedHosts: e.NAKARA_ALLOWED_HOSTS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    allow: e.NAKARA_ALLOW.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    claudeBin: e.NAKARA_CLAUDE_BIN,
    qwenBin: e.NAKARA_QWEN_BIN,
    codexBin: e.NAKARA_CODEX_BIN,
    codexHome: resolve(e.NAKARA_CODEX_HOME),
    limits: {
      budgetUsd: e.NAKARA_BUDGET_USD,
      maxReviews: e.NAKARA_MAX_REVIEWS,
      maxRevisions: e.NAKARA_MAX_REVISIONS,
      maxRuns: e.NAKARA_MAX_RUNS,
    },
    concurrency: e.NAKARA_CONCURRENCY,
    pollSeconds: e.NAKARA_POLL_SECONDS,
    pumpSeconds: e.NAKARA_PUMP_SECONDS,
    drainSeconds: e.NAKARA_DRAIN_SECONDS,
    githubMirror: e.NAKARA_GITHUB_MIRROR,
    backup: {
      dir: e.NAKARA_BACKUP_DIR
        ? resolve(e.NAKARA_BACKUP_DIR)
        : join(dataDir, "backups"),
      keep: e.NAKARA_BACKUP_KEEP,
      intervalHours: e.NAKARA_BACKUP_INTERVAL_HOURS,
    },
    telegram: {
      token: e.NAKARA_TELEGRAM_BOT_TOKEN,
      chatId: e.NAKARA_TELEGRAM_CHAT_ID,
    },
    slack: { enabled: e.NAKARA_SLACK_ENABLED },
    logLevel: e.NAKARA_LOG_LEVEL,
  };
}
