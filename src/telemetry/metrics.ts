// Operational metrics in the Prometheus text format, hand-rolled: counters,
// gauges and histograms with labels, kept in memory for this process. Counters
// start at zero on every start, as Prometheus' rate() and increase() expect.
import { type Logger, silentLogger } from "./log.ts";

type Labels = Record<string, string>;

const escapeLabel = (v: string) =>
  v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const key = (labels: Labels) =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
const sample = (name: string, labels: string, value: number) =>
  `${name}${labels ? `{${labels}}` : ""} ${Number.isFinite(value) ? value : 0}`;

abstract class Metric {
  readonly name: string;
  readonly help: string;
  abstract readonly type: "counter" | "gauge" | "histogram";
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  protected abstract samples(): string[];
  render(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} ${this.type}`,
      ...this.samples(),
    ].join("\n");
  }
}

export class Counter extends Metric {
  readonly type = "counter";
  private readonly values = new Map<string, number>();
  inc(labels: Labels = {}, by = 1): void {
    if (!(by > 0)) return;
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }
  protected samples(): string[] {
    // An unlabelled counter shows 0 before its first increment.
    if (this.values.size === 0) return [sample(this.name, "", 0)];
    return [...this.values].map(([k, v]) => sample(this.name, k, v));
  }
}

export class Gauge extends Metric {
  readonly type = "gauge";
  private readonly values = new Map<string, number>();
  set(labels: Labels, value: number): void {
    this.values.set(key(labels), value);
  }
  get(labels: Labels = {}): number | undefined {
    return this.values.get(key(labels));
  }
  protected samples(): string[] {
    return [...this.values].map(([k, v]) => sample(this.name, k, v));
  }
}

export class Histogram extends Metric {
  readonly type = "histogram";
  private readonly buckets: number[];
  private readonly series = new Map<
    string,
    { counts: number[]; sum: number; count: number }
  >();
  constructor(name: string, help: string, buckets: number[]) {
    super(name, help);
    this.buckets = buckets;
  }
  observe(labels: Labels, value: number): void {
    const k = key(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    for (const [i, le] of this.buckets.entries())
      if (value <= le) s.counts[i] = (s.counts[i] ?? 0) + 1;
    s.sum += value;
    s.count++;
  }
  count(labels: Labels = {}): number {
    return this.series.get(key(labels))?.count ?? 0;
  }
  protected samples(): string[] {
    return [...this.series].flatMap(([k, s]) => {
      const le_ = (le: string) => (k ? `${k},le="${le}"` : `le="${le}"`);
      return [
        ...this.buckets.map((le, i) =>
          sample(`${this.name}_bucket`, le_(String(le)), s.counts[i] ?? 0),
        ),
        sample(`${this.name}_bucket`, le_("+Inf"), s.count),
        sample(`${this.name}_sum`, k, s.sum),
        sample(`${this.name}_count`, k, s.count),
      ];
    });
  }
}

/** Nakara's metrics; see "Monitoring" in the README for what each answers. */
export class Metrics {
  readonly runsTotal = new Counter(
    "nakara_runs_total",
    "Foreman turns and agent runs that ended, by agent, harness and status (succeeded, failed, cancelled, stopped, interrupted).",
  );
  readonly runDuration = new Histogram(
    "nakara_run_duration_seconds",
    "Wall-clock time from the start of a run to its end.",
    [10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200],
  );
  readonly queueDepth = new Gauge(
    "nakara_queue_depth",
    "Work waiting to start: queued agent runs (role=agent) and work items with pending foreman events (role=foreman).",
  );
  readonly runWait = new Histogram(
    "nakara_run_wait_seconds",
    "Time from queueing to start: an agent run since it was queued, a foreman turn since its oldest pending event.",
    [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
  );
  readonly costUsd = new Counter(
    "nakara_cost_usd_total",
    "Spend in USD reported by the harness, by agent.",
  );
  readonly itemsOverBudget = new Counter(
    "nakara_items_over_budget_total",
    "Times a work item's spend reached its budget.",
  );
  readonly pollErrors = new Counter(
    "nakara_intake_poll_errors_total",
    "Failed intake polls and deliveries, by source (github, telegram, slack).",
  );
  readonly lastPoll = new Gauge(
    "nakara_last_poll_timestamp",
    "Unix time of the last completed intake poll, by source.",
  );

  private readonly all: Metric[] = [
    this.runsTotal,
    this.runDuration,
    this.queueDepth,
    this.runWait,
    this.costUsd,
    this.itemsOverBudget,
    this.pollErrors,
    this.lastPoll,
  ];

  /** The exposition: Prometheus text format 0.0.4. */
  render(): string {
    return `${this.all.map((m) => m.render()).join("\n")}\n`;
  }
}

/** The logger and metrics the orchestrator and intake report to. */
export interface Telemetry {
  log: Logger;
  metrics: Metrics;
}

/** No logs, fresh metrics: the default where none is passed, as in tests. */
export const quietTelemetry = (): Telemetry => ({
  log: silentLogger,
  metrics: new Metrics(),
});
