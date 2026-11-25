import type {
  Action,
  AgentType,
  Limits,
  PolicyState,
} from "../domain/policy.ts";

export interface TurnSnapshot {
  foreman: string;
  policy: PolicyState;
  limits: Limits;
  /** The Factory's `owner/name` repositories: Foreman URLs must belong to them. */
  repositories: string[];
  agents: {
    name: string;
    type: AgentType;
    description: string;
    spawnableBy?: string[] | undefined;
  }[];
  /** Agents that already have a conversation in this work item. */
  agentsWithSessions: string[];
}

export interface RecordedAction {
  action: Action;
  accepted: boolean;
  reason?: string;
}
