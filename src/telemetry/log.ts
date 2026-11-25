// Structured logs: one JSON object per line on stdout/stderr (journald keeps them),
// with the level, the event, and the item_id / run_id / agent a child logger
// binds. Secrets are redacted and prompts are never written.

export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

const RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
export const LEVELS = Object.keys(RANK) as [Level, ...Level[]];

const REDACTED = "[redacted]";
/**
 * Fields holding a credential: their value is never written. Anchored, so
 * counts such as input_tokens stay visible.
 */
const SECRET_KEY =
  /(^|_)(token|secret|password|passwd|api_?key)$|authorization|cookie/i;
/** Fields holding a prompt or another agent input: logged by size only. */
const PROMPT_KEY = /^(prompt|input|brief|system_?prompt|instructions)$/i;
/** Credentials recognised by their shape, wherever they appear in a string. */
const SECRET_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  // Telegram bot tokens, also inside api.telegram.org/bot<token>/ URLs.
  /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g,
  // Slack bot, user and app-level tokens.
  /\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}/g,
  /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
];
/** Environment variables whose values are redacted wherever they appear. */
const SECRET_ENV = /TOKEN|SECRET|PASSWORD|API_KEY/;

/** The values of secret-looking environment variables, e.g. GH_TOKEN. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV.test(k) && v && v.length >= 8)
    .map(([, v]) => v as string);
}

/** A copy of `value` with secrets replaced and prompts reduced to their size. */
export function redact(
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const secret of secrets) s = s.replaceAll(secret, REDACTED);
    for (const pattern of SECRET_PATTERNS) s = s.replace(pattern, REDACTED);
    return s;
  }
  if (value instanceof Error) return redact(value.message, secrets, depth);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value))
    return value.map((v) => redact(v, secrets, depth + 1));
  const out: Fields = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k)) out[k] = REDACTED;
    else if (PROMPT_KEY.test(k))
      out[k] = typeof v === "string" ? `[${v.length} chars]` : "[omitted]";
    else out[k] = redact(v, secrets, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  level?: Level;
  /** Receives each line; default stderr for warn and error, stdout for the rest. */
  write?: (line: string, level: Level) => void;
  /** Values redacted wherever they appear; default the secret-looking environment variables. */
  secrets?: string[];
}

/** Warnings and errors go to stderr, the rest to stdout; journald keeps both. */
const writeStd = (line: string, level: Level) =>
  void (RANK[level] >= RANK.warn ? process.stderr : process.stdout).write(
    `${line}\n`,
  );

/** What a logger and its children share. */
interface Sink {
  min: number;
  write: (line: string, level: Level) => void;
  /** Longest first, so a secret containing another is redacted whole. */
  secrets: string[];
}

export class Logger {
  private readonly sink: Sink;
  private readonly bound: Fields;

  constructor(options: LoggerOptions = {}, sink?: Sink, bound: Fields = {}) {
    this.sink = sink ?? {
      min: RANK[options.level ?? "info"],
      write: options.write ?? writeStd,
      secrets: [],
    };
    this.bound = bound;
    if (!sink)
      for (const s of options.secrets ?? envSecrets()) this.addSecret(s);
  }

  /** A logger whose lines also carry `fields`, e.g. item_id, run_id and agent. */
  child(fields: Fields): Logger {
    return new Logger({}, this.sink, { ...this.bound, ...fields });
  }

  /** Redact this value too from now on, in this logger and all its children. */
  addSecret(secret: string): void {
    if (secret.length < 8 || this.sink.secrets.includes(secret)) return;
    this.sink.secrets.push(secret);
    this.sink.secrets.sort((a, b) => b.length - a.length);
  }

  debug(event: string, fields?: Fields): void {
    this.log("debug", event, fields);
  }
  info(event: string, fields?: Fields): void {
    this.log("info", event, fields);
  }
  warn(event: string, fields?: Fields): void {
    this.log("warn", event, fields);
  }
  error(event: string, fields?: Fields): void {
    this.log("error", event, fields);
  }

  private log(level: Level, event: string, fields: Fields = {}): void {
    if (RANK[level] < this.sink.min) return;
    const line = redact(
      {
        time: new Date().toISOString(),
        level,
        event,
        ...this.bound,
        ...fields,
      },
      this.sink.secrets,
    );
    this.sink.write(JSON.stringify(line), level);
  }
}

/** Writes nothing; the default where no logger is passed, as in tests. */
export const silentLogger = new Logger({ write: () => {}, secrets: [] });
