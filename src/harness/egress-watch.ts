// A harness whose model host the egress proxy refuses retries until its turn
// times out (codex: "Reconnecting... waiting for network"). This watches the
// harness's own output for those refusals and ends the run early, naming the
// host and the runner's egress allow list.
import type { HarnessKind } from "../definition/load.ts";
import { HARNESS_HOSTS } from "../runner/docker.ts";

/** Refusals of one host that end the run. */
export const EGRESS_REFUSALS = 3;
/** How long after a refusal the run waits for the model to answer before it ends. */
export const EGRESS_GRACE_MS = 60_000;

const URL_HOST = /\b(?:https?|wss?):\/\/([a-z0-9.-]+)/i;
const NOT_ALLOWED =
  /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)? is not on the egress allowlist/i;
const PROXY_403 =
  /\b403\b[^\n]*\b(?:connect|proxy|tunnel)|\b(?:connect|proxy|tunnel)[^\n]*\b403\b/i;
const CONNECT_TARGET = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+):443\b/i;

/**
 * The host an egress proxy refused, from one line of a harness's own output
 * (`HTTP CONNECT failed with status 403, url: wss://chatgpt.com/...`), or null.
 */
export function refusedHost(line: string): string | null {
  const named = NOT_ALLOWED.exec(line)?.[1];
  if (named) return named.toLowerCase();
  if (!PROXY_403.test(line)) return null;
  const host = URL_HOST.exec(line)?.[1] ?? CONNECT_TARGET.exec(line)?.[1];
  return host ? host.toLowerCase() : null;
}

/**
 * Counts egress refusals of a harness's model host. `onBlocked` is called once,
 * with the reason to fail the run, after EGRESS_REFUSALS refusals of one host
 * or `graceMs` after a refusal the model never answered past.
 */
export class EgressWatch {
  private readonly hosts: string[];
  private readonly allow: string[] | undefined;
  private readonly graceMs: number;
  private readonly onBlocked: (reason: string) => void;
  private readonly counts = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  /** Why the run was ended; null while it was not. */
  blocked: string | null = null;

  constructor(
    harness: HarnessKind,
    allow: string[] | undefined,
    onBlocked: (reason: string) => void,
    graceMs = EGRESS_GRACE_MS,
  ) {
    this.hosts = HARNESS_HOSTS[harness];
    this.allow = allow;
    this.onBlocked = onBlocked;
    this.graceMs = graceMs;
  }

  /** One line of the harness's own output (stderr, or a stream event that is not a tool's). */
  line(text: string): void {
    if (this.blocked) return;
    const host = refusedHost(text);
    // qwen's gateway is the wrapper's: any host it is refused counts.
    if (!host || (this.hosts.length && !this.hosts.includes(host))) return;
    const count = (this.counts.get(host) ?? 0) + 1;
    this.counts.set(host, count);
    if (count >= EGRESS_REFUSALS) this.block(host, count);
    else
      this.timer ??= setTimeout(
        () => this.block(host, this.counts.get(host) ?? count),
        this.graceMs,
      );
  }

  /** The model answered: earlier refusals were transient. */
  progress(): void {
    this.counts.clear();
    this.stop();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private block(host: string, count: number): void {
    this.stop();
    if (this.blocked) return;
    const allow = this.allow?.length
      ? ` The runner's egress allows only: ${this.allow.join(", ")}.`
      : "";
    this.blocked = `The harness cannot reach its model: the egress proxy refused ${host} (${count} time${count === 1 ? "" : "s"}).${allow} Add ${host} to the runner's egress.allow, or give the agent a harness its runner can reach.`;
    this.onBlocked(this.blocked);
  }
}
