import { z } from "zod";
import type { Store } from "../db.ts";
import type { AutomationDef } from "../definition/load.ts";
import { cronMatches, parseCron } from "../intake/schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Five years includes the next leap day. Impossible schedules return null.
export const NEXT_FIRE_MINUTES = 5 * 366 * 24 * 60;
export function nextFire(
  cron: string,
  now: Date,
  bound = NEXT_FIRE_MINUTES,
): string | null {
  const parsed = parseCron(cron);
  const [minutes, hours] = parsed.fields
    .slice(0, 2)
    .map((field) => [...field].sort((a, b) => a - b)) as [number[], number[]];
  const [firstMinute = 0] = minutes;
  const [firstHour = 0] = hours;
  const floor = Math.floor(now.getTime() / MINUTE) * MINUTE;
  const start = floor + MINUTE;
  const end = floor + bound * MINUTE;
  // Day by day, then only the cron's own hours and minutes: about 1.8k steps for five years.
  for (let day = start - (start % DAY); day <= end; day += DAY) {
    // The first matching time of day isolates the day-of-month, month and weekday check.
    const probe = new Date(day + firstHour * HOUR + firstMinute * MINUTE);
    if (!cronMatches(parsed, probe)) continue;
    for (const hour of hours)
      for (const minute of minutes) {
        const time = day + hour * HOUR + minute * MINUTE;
        if (time > end) return null;
        if (time >= start) return new Date(time).toISOString();
      }
  }
  return null;
}

export interface AutomationDto {
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
  instructions: string;
  /** Identifies the automation.md the page was loaded from; a save must send it back. */
  revision: string | null;
  agent: string;
  runner: string | null;
  model: string | null;
  idleTimeoutMinutes: number | null;
  triggers: {
    provider: string;
    event: string;
    filter: Record<string, unknown>;
    cron: string | null;
    nextFire: string | null;
  }[];
  itemCount: number;
  recentItems: {
    id: number;
    title: string;
    stage: string;
    createdAt: string;
  }[];
}

/** The one trigger the drawer edits; see TriggerEdit. */
const triggerEditInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("github_label"),
      label: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule"),
      cron: z.string().trim().min(1).max(255),
    })
    .strict(),
  z
    .object({
      kind: z.literal("slack"),
      members: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
    })
    .strict(),
  z.object({ kind: z.literal("telegram") }).strict(),
]);

/**
 * Any of the switch, instructions, display name, starting agent and trigger; an
 * omitted field keeps its value. A null or empty displayName removes it.
 */
export const automationEditInput = z
  .object({
    enabled: z.boolean().optional(),
    instructions: z.string().max(200_000).optional(),
    displayName: z.string().max(200).nullable().optional(),
    agent: z.string().min(1).max(255).optional(),
    trigger: triggerEditInput.optional(),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const cronPreviewInput = z
  .object({ cron: z.string().max(255) })
  .strict();

/** The next fire time of a cron the drawer is editing, or why it is not valid. */
export function cronPreview(
  cron: string,
  now: Date,
): { valid: true; nextFire: string | null } | { valid: false; error: string } {
  try {
    return { valid: true, nextFire: nextFire(cron, now) };
  } catch (error) {
    return { valid: false, error: (error as Error).message };
  }
}

/**
 * Pure projection of the Store and active definition; the caller supplies the
 * clock. A GitHub issue_labeled trigger without a labels filter polls the
 * factory's `label`, so its filter shows that label.
 */
export function readAutomations(
  store: Store,
  definitions: readonly AutomationDef[],
  now: Date,
  label?: string,
): AutomationDto[] {
  return definitions.map((automation) => {
    const { name, agent, instructions, frontmatter: fm } = automation;
    const history = store.automationHistory(name);
    return {
      name,
      displayName: fm.displayName ?? name,
      description:
        typeof fm.description === "string"
          ? fm.description
          : (instructions.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ") ?? ""),
      enabled: fm.enabled,
      instructions,
      revision: automation.revision ?? null,
      agent,
      runner: fm.runner ?? null,
      model: fm.harness?.model ?? fm.model ?? null,
      idleTimeoutMinutes: fm.idleTimeoutMinutes ?? null,
      triggers: fm.triggers.map((trigger) => {
        // Only schedule/cron_fired fires, and only its cron is validated on load.
        const cron =
          trigger.provider === "schedule" && trigger.event === "cron_fired"
            ? (trigger.schedule?.cron ?? null)
            : null;
        const filter = trigger.filter ?? {};
        const labeled =
          trigger.provider === "github" && trigger.event === "issue_labeled";
        return {
          provider: trigger.provider,
          event: trigger.event,
          filter:
            labeled && label !== undefined && filter.labels === undefined
              ? { labels: [label], ...filter }
              : filter,
          cron,
          nextFire: cron ? nextFire(cron, now) : null,
        };
      }),
      itemCount: history.count,
      recentItems: history.items.map((item) => ({
        id: item.id,
        title: item.title,
        stage: item.stage,
        createdAt: item.created_at,
      })),
    };
  });
}
