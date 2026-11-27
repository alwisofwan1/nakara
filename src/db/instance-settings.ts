import type { Store } from "../db.ts";

/** Where the Operator's concurrency lives in kv; absent means the environment default. */
export const CONCURRENCY_KEY = "settings:concurrency";
/** The range the Operator may save; `NAKARA_CONCURRENCY` itself is not bounded by it. */
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 10;

/** The instance's agent run slots: the effective value, the saved one, and the default it falls back to. */
export interface ConcurrencySetting {
  concurrency: number;
  /** The Operator's value; null uses the default. */
  saved: number | null;
  /** `NAKARA_CONCURRENCY`. */
  default: number;
}

const savedValue = (store: Store): number | null => {
  const raw = store.getKv(CONCURRENCY_KEY);
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isInteger(value) &&
    value >= CONCURRENCY_MIN &&
    value <= CONCURRENCY_MAX
    ? value
    : null;
};

/**
 * How many agent runs may run at once, across every factory. A saved value
 * wins; none means `fallback` (`NAKARA_CONCURRENCY`), as ADR-0006 rule 1 has
 * it for factory limits.
 */
export function concurrencySetting(
  store: Store,
  fallback: number,
): ConcurrencySetting {
  const saved = savedValue(store);
  return { concurrency: saved ?? fallback, saved, default: fallback };
}

/** Save the instance's concurrency; null returns to the environment default. */
export function saveConcurrency(store: Store, value: number | null): void {
  if (value === null) {
    store.repos.kv.deleteKv(CONCURRENCY_KEY);
    store.notify({ type: "status", id: "global" });
  } else store.setKv(CONCURRENCY_KEY, String(value));
}
