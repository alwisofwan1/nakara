// Recognises a rate limit or usage limit in what a harness CLI printed, so a
// limited run can move to a fallback harness or wait for the reset instead of
// failing (see AgentRunner).
//
// claude (Claude Code 2.x, `-p --output-format stream-json`), from the CLI's
// own stream-json writer:
// - `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected",
//   "resetsAt":<epoch seconds>,"rateLimitType":"five_hour",…}}` when the
//   account's limit refuses a request ("allowed"/"allowed_warning" otherwise).
// - The refused request as an assistant message with top-level
//   `"error":"rate_limit"`, `"is_api_error_message":true`,
//   `"api_error_status":429`, and for a plan or usage limit
//   `"api_error":"usage_limit_reached"` with
//   `"api_error_params":{"rate_limit_info":{…same shape…}}`. Its text is
//   "You've hit your session limit · resets 3pm (Europe/Berlin)" and the like.
// - The result then has `"is_error":true` and repeats that text and api_error.
// - Claude Code 1.x printed "Claude AI usage limit reached|<epoch seconds>"
//   as the result text instead.
// Only those signals count: a limit text quoted by a tool, an MCP server or
// the agent's own reply (an API's "429 Too Many Requests") is no limit of the
// harness, and neither is stderr.
//
// codex (`codex exec --json`): an `{"type":"error","message":…}` event and
// `{"type":"turn.failed","error":{"message":…}}` carrying codex's error text:
// - "You've hit your usage limit. Upgrade to Pro (…) or try again at 3:04 PM."
//   (also "… try again at Jan 5th, 2026 3:04 PM." or "… try again in 2 days
//   3 hours 4 minutes."), for a ChatGPT plan's usage limit;
// - "exceeded retry limit, last status: 429 Too Many Requests", when its
//   retries of a throttled request ran out;
// - "Rate limit reached for gpt-5 in organization … Please try again in
//   1.5s.", the OpenAI API's own 429 text with an API key.
// Only the message of those two events counts, and only when it starts with
// one of these texts; item events (tool output, the agent's reply) never do.

/** What the error of a run that hit a limit says (see limitError). */
export const LIMIT_HIT = "hit a rate or usage limit";

/** A run the harness refused because of a rate or usage limit. */
export interface RateLimit {
  /** When the limit resets (ISO), when the CLI said. */
  resetAt: string | null;
  /** What the CLI said, for the operator. */
  message: string;
  /** The model did some work before the limit, so the run is no fresh start. */
  worked: boolean;
}

/**
 * How Claude Code's own limit error starts, in the text of its synthetic
 * API-error message or its error result: never matched anywhere else.
 */
const CLAUDE_LIMIT =
  /^(?:Claude AI usage limit reached\||You['’]ve (?:hit|reached) your (?:[\w-]+ ){0,3}limit\b|API Error: 429\b)/i;

/** How codex's own limit error starts, in its error or turn.failed event. */
const CODEX_LIMIT =
  /^(?:stream error: )?(?:You['’]ve hit your usage limit\b|exceeded retry limit, last status: 429\b|Rate limit reached for )/i;

/** Whether claude's error text is its limit error. */
export const isClaudeLimit = (text: string): boolean =>
  CLAUDE_LIMIT.test(text.trim());

/** Whether codex's error message is its limit error. */
export const isCodexLimit = (text: string): boolean =>
  CODEX_LIMIT.test(text.trim());

const iso = (ms: number) => new Date(ms).toISOString();

/** An epoch in seconds (or milliseconds) as ISO; null when it is no time. */
function epoch(value: unknown): string | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return iso(n < 1e12 ? n * 1000 : n);
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

/** "minutes" → "minute", "ms" stays. */
const unitOf = (unit: string) => {
  const u = unit.toLowerCase();
  return u !== "ms" && u.length > 1 && u.endsWith("s") ? u.slice(0, -1) : u;
};

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * When a limit text says it resets: "|<epoch>", "try again in 2 days 3 hours",
 * "try again in 1.5s", "try again at 3:04 PM" (the next such time, local) or
 * "try again at Jan 5th, 2026 3:04 PM" (local). Null when it does not say.
 */
export function resetFromText(text: string, now = Date.now()): string | null {
  const legacy = /usage limit reached\|(\d{9,13})/i.exec(text);
  if (legacy) return epoch(legacy[1]);
  const after = /try again in ((?:\s*(?:and\s+)?[\d.]+\s*[a-z]+,?)+)/i.exec(
    text,
  );
  if (after?.[1]) {
    let ms = 0;
    for (const [, n, unit] of after[1].matchAll(/([\d.]+)\s*([a-z]+)/gi)) {
      const scale = UNIT_MS[unitOf(unit ?? "")];
      if (scale === undefined) return null;
      ms += Number(n) * scale;
    }
    return ms > 0 ? iso(now + Math.ceil(ms)) : null;
  }
  const at =
    /try again at (?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(
      text,
    );
  if (at) {
    const [, month, day, year, h, m, ampm] = at;
    let hour = Number(h) % (ampm ? 12 : 24);
    if (ampm?.toUpperCase() === "PM") hour += 12;
    const date = new Date(now);
    if (month && day && year) {
      const mi = MONTHS.indexOf(month.toLowerCase());
      if (mi < 0) return null;
      date.setFullYear(Number(year), mi, Number(day));
    }
    date.setHours(hour, Number(m), 0, 0);
    // A time of day that has passed today is tomorrow's.
    if (!month && date.getTime() <= now) date.setDate(date.getDate() + 1);
    return iso(date.getTime());
  }
  return null;
}

/**
 * Follows one harness run's stream for a limit; `limit()` reports it once the
 * run has failed. A limit the CLI got past (a warning, or a retry that then
 * succeeded) never fails the run, so it is never reported.
 */
export class LimitWatch {
  private resetAt: string | null = null;
  private message: string | null = null;
  /** Model output arrived that was not a limit refusal: the run did work. */
  worked = false;

  /** A claude stream-json event. */
  claude(event: Record<string, unknown>): void {
    if (event.type === "result") {
      // The error result repeats the refused request's api_error and text.
      if (event.is_error !== true) return;
      const text = typeof event.result === "string" ? event.result : "";
      if (event.api_error === "usage_limit_reached" || isClaudeLimit(text)) {
        this.resetAt = resetFromText(text) ?? this.resetAt;
        this.message ??= text || "usage limit reached";
      }
      return;
    }
    if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      // Only when it resets: the refused request that follows is the limit.
      if (info?.status === "rejected")
        this.resetAt = epoch(info.resetsAt) ?? this.resetAt;
      return;
    }
    if (event.type !== "assistant") return;
    const params = event.api_error_params as
      | { rate_limit_info?: Record<string, unknown> }
      | undefined;
    const text = assistantText(event);
    // Claude Code writes an API error as a message of its own ("<synthetic>").
    const synthetic =
      event.is_api_error_message === true ||
      (event.message as { model?: unknown } | undefined)?.model ===
        "<synthetic>";
    if (
      event.error === "rate_limit" ||
      event.api_error === "usage_limit_reached" ||
      (synthetic && text && isClaudeLimit(text))
    ) {
      this.resetAt =
        epoch(params?.rate_limit_info?.resetsAt) ??
        (text ? resetFromText(text) : null) ??
        this.resetAt;
      this.message = text ?? this.message ?? "rate limit";
    } else if (!synthetic) this.worked = true;
  }

  /** A codex `--json` event. */
  codex(event: Record<string, unknown>): void {
    const text =
      event.type === "error"
        ? String(event.message ?? "")
        : event.type === "turn.failed"
          ? String(
              (event.error as { message?: unknown } | undefined)?.message ?? "",
            )
          : "";
    if (text && isCodexLimit(text)) {
      this.message = text;
      this.resetAt = resetFromText(text) ?? this.resetAt;
    } else if (String(event.type).startsWith("item.")) this.worked = true;
  }

  /** The limit that ended a failed run, as its stream reported it; null when it hit none. */
  limit(): RateLimit | null {
    if (!this.message) return null;
    return {
      resetAt: this.resetAt,
      message: this.message.trim().slice(0, 500),
      worked: this.worked,
    };
  }
}

function assistantText(event: Record<string, unknown>): string | null {
  const message = event.message as
    | { content?: { type: string; text?: string }[] }
    | undefined;
  const text = message?.content
    ?.filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
  return text || null;
}
