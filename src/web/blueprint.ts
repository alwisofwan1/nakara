import type { Store } from "../db.ts";
import { STAGES, type Stage } from "../domain/policy.ts";

/**
 * The moves the foreman's prompt (factory/agents/foreman/agent.md) lays out.
 * The policy allows others; those appear once one is recorded.
 */
export const DESIGNED_TRANSITIONS: readonly [Stage, Stage][] = [
  ["intake", "triage"],
  ["intake", "building"], // trivial work skips triage
  ["triage", "planning"],
  ["triage", "building"],
  ["triage", "complete"], // an informational question needs no PR
  ["planning", "building"],
  ["building", "reviewing"],
  ["reviewing", "building"], // findings go back as a revision
  ["reviewing", "handoff"],
  ["handoff", "building"], // failing CI or requested changes
  ["handoff", "complete"],
];

/** The stage whose agent runs an agent type counts toward. */
const RUN_STAGE: Record<string, Stage> = {
  TRIAGE: "triage",
  SPEC: "planning",
  IMPLEMENT: "building",
  CUSTOM: "building",
  REVIEW: "reviewing",
  VERIFY: "reviewing", // verification checks the change before handoff
};

export interface BlueprintStageDto {
  stage: Stage;
  /** Agent runs of the agent types that work in this stage. */
  runs: number;
  /** Open work items in this stage now. */
  open: number;
  /** Recorded entries into this stage. */
  entered: number;
}

export interface BlueprintTransitionDto {
  /** null: the stage a work item started in. */
  from: Stage | null;
  to: Stage;
  designed: boolean;
  /** Recorded moves; history starts when Nakara began recording them. */
  count: number;
}

export interface BlueprintDto {
  stages: BlueprintStageDto[];
  transitions: BlueprintTransitionDto[];
}

/** A factory's stages and the moves between them, with what was recorded. */
export function readBlueprint(store: Store, factoryId?: number): BlueprintDto {
  const flow = store.stageFlow(factoryId);
  const open = store.items({ open: true, factoryId });
  const stages = STAGES.map((stage) => ({
    stage,
    runs: flow.runs
      .filter((r) => RUN_STAGE[r.agentType] === stage)
      .reduce((sum, r) => sum + r.count, 0),
    open: open.filter((item) => item.stage === stage).length,
    entered: flow.transitions
      .filter((t) => t.to === stage)
      .reduce((sum, t) => sum + t.count, 0),
  }));
  const count = (from: Stage | null, to: Stage) =>
    flow.transitions.find((t) => t.from === from && t.to === to)?.count ?? 0;
  const designed = DESIGNED_TRANSITIONS.map(([from, to]) => ({
    from,
    to,
    designed: true,
    count: count(from, to),
  }));
  const recorded = flow.transitions
    .filter(
      (t) =>
        t.from !== null &&
        !DESIGNED_TRANSITIONS.some(
          ([from, to]) => from === t.from && to === t.to,
        ),
    )
    .map((t) => ({ ...t, designed: false }))
    .sort((a, b) => b.count - a.count);
  return { stages, transitions: [...designed, ...recorded] };
}
