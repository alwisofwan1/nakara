import { z } from "zod";
import type { Store } from "../db.ts";
import {
  type AgentDef,
  type Definition,
  HARNESS_FALLBACK,
  resolveHarness,
} from "../definition/load.ts";
import { AGENT_NAME, type AgentEdit } from "../definition/write.ts";
import { AGENT_TYPES } from "../domain/policy.ts";

export interface AgentSummaryDto {
  name: string;
  type: string;
  description: string;
  harness: string;
  model: string | null;
}
export interface AgentDto extends AgentSummaryDto {
  prompt: string;
  settings: { name: string; value: string; inherited: boolean }[];
  automations: { name: string; enabled: boolean; triggers: string[] }[];
  runs: { id: number; status: string; startedAt: string; itemId: number }[];
  /** The values as written in agent.md; null means the default applies. */
  form: AgentEdit;
  /** What an unset value falls back to. */
  defaults: {
    harness: string;
    model: string;
    runner: string;
    idleTimeoutMinutes: number;
  };
  options: { runners: string[]; agents: string[] };
  /** Saved edits become uncommitted changes in a git work tree. */
  gitTracked: boolean;
  /** Identifies the agent.md the form was loaded from; a save must send it back. */
  revision: string | null;
}
/** A full Settings and Prompt form; the loader validates the values themselves. */
export const agentEditInput = z
  .object({
    description: z.string().trim().max(2_000).nullable(),
    harness: z.string().trim().min(1).max(100).nullable(),
    model: z.string().trim().min(1).max(200).nullable(),
    effort: z
      .string()
      .regex(/^[a-z]{1,20}$/, "Effort is a lowercase word such as high")
      .nullable(),
    runner: z.string().trim().min(1).max(100).nullable(),
    spawnableBy: z.array(z.string().trim().min(1).max(255)).max(100).nullable(),
    idleTimeoutMinutes: z.number().int().nullable(),
    prompt: z.string().max(200_000),
    revision: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

/** A new agent; the loader validates it with the rest of the definition. */
export const newAgentInput = z
  .object({
    name: z
      .string()
      .trim()
      .regex(
        AGENT_NAME,
        "Use lowercase letters, digits, - and _, starting with a letter or digit (not new)",
      ),
    type: z.enum(AGENT_TYPES),
    description: z.string().trim().max(2_000).nullable(),
    prompt: z.string().max(200_000),
  })
  .strict();
/** The revision of the agent.md the page showed, so a changed file is not deleted. */
export const agentDeleteInput = z
  .object({ revision: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

function summary(agent: AgentDef): AgentSummaryDto {
  return {
    name: agent.name,
    type: agent.type,
    description: agent.description,
    harness: agent.harness.kind,
    model: agent.harness.model ?? null,
  };
}
export function readAgents(
  _store: Store,
  definition: Definition | undefined,
): AgentSummaryDto[] {
  if (!definition) return [];
  return [
    definition.foreman,
    ...[...definition.agents.values()].filter(
      (a) => a.name !== definition.foreman.name,
    ),
  ].map(summary);
}
export function readAgent(
  store: Store,
  definition: Definition | undefined,
  name: string,
  gitTracked = false,
): AgentDto | undefined {
  const agent = definition?.agents.get(name);
  if (!agent || !definition) return undefined;
  const setting = (key: string, name: string, value: string) => ({
    name,
    value,
    inherited: !agent.explicitSettings?.includes(key),
  });
  const base = resolveHarness(
    definition.factory.agentDefaults,
    HARNESS_FALLBACK,
  ).harness;
  return {
    ...summary(agent),
    prompt: agent.instructions,
    settings: [
      setting("description", "Description", agent.description || "None"),
      setting(
        "mcpServers",
        "MCPs",
        Object.keys(agent.mcpServers).join(", ") || "None",
      ),
      {
        name: "Skills",
        value:
          agent.skills
            .filter((s) => !agent.localSkills?.includes(s.name))
            .map((s) => s.name)
            .join(", ") || "None",
        inherited: true,
      },
      {
        name: "Agent skills",
        value: agent.localSkills?.join(", ") || "None",
        inherited: false,
      },
      setting("harness", "Harness", agent.harness.kind),
      setting(
        "model",
        "Model",
        [agent.harness.model ?? "Harness default", agent.harness.effort]
          .filter(Boolean)
          .join(" · "),
      ),
      setting("runner", "Runner", agent.runner ?? "local"),
      setting(
        "spawnableBy",
        "spawnableBy",
        agent.spawnableBy?.join(", ") ||
          (agent.spawnableBy ? "None" : "Any agent"),
      ),
      setting(
        "idleTimeoutMinutes",
        "Idle timeout",
        `${agent.idleTimeoutMinutes} minutes`,
      ),
    ],
    automations: definition.automations
      .filter((a) => a.agent === name)
      .map((a) => ({
        name: a.frontmatter.displayName ?? a.name,
        enabled: a.frontmatter.enabled,
        triggers: a.frontmatter.triggers.map((t) => `${t.provider}/${t.event}`),
      })),
    runs: store.runsForAgent(name).map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.started_at,
      itemId: r.item_id,
    })),
    form: agentForm(agent),
    defaults: {
      harness: base.kind,
      model: base.model ?? "Harness default",
      runner: definition.factory.agentDefaults.runner ?? "local",
      idleTimeoutMinutes:
        definition.factory.agentDefaults.idleTimeoutMinutes ?? 60,
    },
    options: {
      runners: [...definition.runners.keys()],
      agents: [...definition.agents.keys()],
    },
    gitTracked,
    revision: agent.revision ?? null,
  };
}

function agentForm(agent: AgentDef): AgentEdit {
  const fm = agent.frontmatter;
  return {
    description: fm?.description ?? null,
    harness: fm?.harness?.type ?? null,
    model: (fm?.harness ? fm.harness.model : fm?.model) ?? null,
    effort: fm?.harness?.reasoningLevel ?? null,
    runner: fm?.runner ?? null,
    spawnableBy: fm?.spawnableBy ?? null,
    idleTimeoutMinutes: fm?.idleTimeoutMinutes ?? null,
    prompt: agent.instructions,
  };
}
