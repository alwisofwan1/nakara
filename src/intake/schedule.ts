// schedule/cron_fired: automations with `schedule.cron` (5 fields or macros, UTC) create a
// work item each time they match. The source_ref is unique per automation and
// minute, so a restart within the minute never fires twice.
// ponytail: minutes missed while Nakara is down are skipped, not caught up.
import type { AutomationDef } from "../definition/load.ts";
import type { Factory } from "../orchestrator/factory.ts";

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;
const MACROS = new Map([
  ["@hourly", "0 * * * *"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@weekly", "0 0 * * 0"],
  ["@monthly", "0 0 1 * *"],
]);

export type Cron = { fields: Set<number>[]; domAny: boolean; dowAny: boolean };

/** Parse `m h dom mon dow` with *, lists, ranges and steps, or a supported macro. */
// ponytail: no month/day names; add when a definition needs them.
export function parseCron(expr: string): Cron {
  const trimmed = expr.trim();
  const parts = (MACROS.get(trimmed) ?? trimmed).split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" must have 5 fields`);
  const fields = parts.map((part, i) => {
    // biome-ignore lint/style/noNonNullAssertion: The five-field validation guarantees a matching range for each index.
    const [lo, hi] = RANGES[i]!;
    const set = new Set<number>();
    for (const item of part.split(",")) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`cron "${expr}": bad field "${part}"`);
      const from = m[1] === "*" ? lo : Number(m[2]);
      const to =
        m[1] === "*"
          ? hi
          : m[3] !== undefined
            ? Number(m[3])
            : m[4]
              ? hi
              : from;
      const step = m[4] ? Number(m[4]) : 1;
      if (from < lo || to > hi || from > to || step < 1)
        throw new Error(`cron "${expr}": "${item}" is out of range`);
      for (let v = from; v <= to; v += step)
        set.add(i === 4 && v === 7 ? 0 : v);
    }
    return set;
  });
  return { fields, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

export function cronMatches(cron: Cron, d: Date): boolean {
  const [min, hour, dom, mon, dow] = cron.fields as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (
    !min.has(d.getUTCMinutes()) ||
    !hour.has(d.getUTCHours()) ||
    !mon.has(d.getUTCMonth() + 1)
  )
    return false;
  const domOk = dom.has(d.getUTCDate());
  const dowOk = dow.has(d.getUTCDay());
  // Vixie cron: when both day fields are restricted, either one matching is enough.
  return cron.domAny || cron.dowAny ? domOk && dowOk : domOk || dowOk;
}

/** The title and request of the work item a schedule trigger creates at `now`. */
export function scheduledWork(
  automation: AutomationDef,
  schedule: { name?: string | undefined; cron: string },
  now: Date,
): { title: string; request: string } {
  const minute = now.toISOString().slice(0, 16);
  const name =
    schedule.name ?? automation.frontmatter.displayName ?? automation.name;
  return {
    title: `${name} (${minute.replace("T", " ")} UTC)`,
    request: `Scheduled run of ${name} (cron \`${schedule.cron}\`, UTC). Follow the automation instructions.`,
  };
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  readonly factory: Factory;
  constructor(factory: Factory) {
    this.factory = factory;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(new Date()), 30_000);
    this.tick(new Date());
  }

  stop(): void {
    clearInterval(this.timer);
  }

  tick(now: Date): void {
    const def = this.factory.definition;
    if (!def) return;
    const minute = now.toISOString().slice(0, 16);
    // Source refs are unique across factories: another factory may have an
    // automation of the same name. The first factory keeps its old refs.
    const record = this.factory.record;
    const scope =
      record &&
      record.id !== this.factory.store.repos.factories.defaultFactory().id
        ? `${record.slug}/`
        : "";
    for (const automation of def.automations) {
      if (!automation.frontmatter.enabled) continue;
      for (const trigger of automation.frontmatter.triggers) {
        if (
          trigger.provider !== "schedule" ||
          trigger.event !== "cron_fired" ||
          !trigger.schedule
        )
          continue;
        if (!cronMatches(parseCron(trigger.schedule.cron), now)) continue;
        const ref = `schedule:${scope}${automation.name}:${minute}`;
        if (this.factory.store.itemBySourceRef(ref)) continue;
        this.factory.createWorkItem({
          ...scheduledWork(automation, trigger.schedule, now),
          requester: null,
          source: "schedule",
          sourceRef: ref,
          repo: null,
          automation: automation.name,
        });
      }
    }
  }
}
