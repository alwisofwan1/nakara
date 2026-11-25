// What a claude run cost when it never reported its own total: the usage its
// assistant messages streamed, priced per model. Only an estimate (list
// prices, 5-minute cache writes), so a stopped run still counts toward the
// work item's budget instead of costing nothing.

/** USD per million tokens. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const price = (input: number, output: number, cacheRead = input / 10) => ({
  input,
  output,
  cacheRead,
});

// Most specific first: the first key the model id contains wins.
const PRICES: [string, Price][] = [
  ["fable-5-2", price(8, 40, 0.2)],
  ["mythos-5-2", price(8, 40, 0.2)],
  ["fable", price(10, 50)],
  ["mythos", price(10, 50)],
  ["opus-5-5", price(4, 20, 0.2)],
  ["opus-4-1", price(15, 75)],
  ["opus-4-2", price(15, 75)],
  ["opus-4-0", price(15, 75)],
  ["opus", price(5, 25)],
  ["sonnet-5-5", price(2, 10, 0.1)],
  ["sonnet-5", price(2, 10, 0.2)],
  ["sonnet", price(3, 15)],
  ["haiku-5-5", price(0.1, 0.5, 0.01)],
  ["haiku", price(1, 5)],
];
/** An unknown model is priced like an Opus, so the estimate errs high. */
const FALLBACK = price(5, 25);
/** Cache writes (5-minute) cost 1.25 × input. */
const CACHE_WRITE = 1.25;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** The list price of one message's usage on `model`. */
export function usageCost(model: string | undefined, usage: Usage): number {
  const id = (model ?? "").toLowerCase();
  const p = PRICES.find(([key]) => id.includes(key))?.[1] ?? FALLBACK;
  const n = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return (
    (n(usage.input_tokens) * p.input +
      n(usage.cache_creation_input_tokens) * p.input * CACHE_WRITE +
      n(usage.cache_read_input_tokens) * p.cacheRead +
      n(usage.output_tokens) * p.output) /
    1_000_000
  );
}

/**
 * Sums the usage of a claude stream's assistant messages. Claude Code emits
 * one `assistant` line per content block, each repeating its message's usage,
 * so a message counts once, with the last usage it reported.
 */
export class StreamCost {
  private readonly messages = new Map<string, number>();
  private anonymous = 0;
  private count = 0;

  /** Record one stream event; anything but an assistant message is ignored. */
  add(event: Record<string, unknown>): void {
    if (event.type !== "assistant") return;
    const message = event.message as
      | { id?: unknown; model?: unknown; usage?: Usage }
      | undefined;
    if (!message?.usage) return;
    const cost = usageCost(
      typeof message.model === "string" ? message.model : undefined,
      message.usage,
    );
    if (typeof message.id === "string") this.messages.set(message.id, cost);
    else this.anonymous += cost;
    this.count++;
  }

  /** Whether any usage was seen. */
  get seen(): boolean {
    return this.count > 0;
  }

  get usd(): number {
    let total = this.anonymous;
    for (const cost of this.messages.values()) total += cost;
    return total;
  }
}
