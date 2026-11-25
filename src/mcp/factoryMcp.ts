// Stdio MCP server that Claude Code spawns for one foreman turn. Each tool
// checks the policy against the turn's state snapshot and appends accepted
// actions to a JSONL file; the orchestrator applies them after the turn ends
// (and re-checks them). Tools never block on long work, so MCP timeouts are moot.
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { check, type Action } from "../domain/policy.ts";
import type { RecordedAction, TurnSnapshot } from "./types.ts";

const statePath = process.env.NAKARA_STATE;
const actionsPath = process.env.NAKARA_ACTIONS;
if (!statePath || !actionsPath)
  throw new Error("NAKARA_STATE and NAKARA_ACTIONS are required");

const snapshot = JSON.parse(readFileSync(statePath, "utf8")) as TurnSnapshot;
let state = snapshot.policy;

const record = (entry: RecordedAction) => {
  // Never through a symlink planted in its place.
  const fd = openSync(
    actionsPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
  );
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
  } finally {
    closeSync(fd);
  }
};
const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  isError,
});

function submit(action: Action, accepted: string) {
  const verdict = check(state, action, snapshot.limits, snapshot.repositories);
  if (!verdict.ok) {
    record({ action, accepted: false, reason: verdict.reason });
    return text(`Refused by factory policy: ${verdict.reason}`, true);
  }
  state = verdict.next;
  record({ action, accepted: true });
  return text(accepted);
}

function agentFor(name: string) {
  const agent = snapshot.agents.find((a) => a.name === name);
  if (!agent)
    return {
      error: `Unknown agent "${name}". Available: ${snapshot.agents.map((a) => a.name).join(", ")}`,
    };
  if (agent.spawnableBy && !agent.spawnableBy.includes(snapshot.foreman))
    return { error: `Agent "${name}" cannot be dispatched by the foreman.` };
  return { agent };
}

const server = new McpServer({ name: "nakara", version: "0.1.0" });

server.registerTool(
  "dispatch_agent",
  {
    description:
      "Start a new conversation with a factory agent. Runs asynchronously: end your turn after dispatching; you are woken with the agent's report. The brief must be self-contained.",
    inputSchema: { agent: z.string(), brief: z.string().min(1) },
  },
  async ({ agent, brief }) => {
    const found = agentFor(agent);
    if ("error" in found) return text(found.error ?? "", true);
    return submit(
      { type: "dispatch_agent", agent, agentType: found.agent.type, brief },
      `Dispatched ${agent}. End your turn now; its report will wake you.`,
    );
  },
);

server.registerTool(
  "follow_up",
  {
    description:
      "Send a message to an agent's existing conversation (answers, review findings, CI failures, spec feedback). The agent keeps its context. Asynchronous like dispatch_agent. With push_only, Nakara sends the implementation agent its own push-only prompt instead of the message; available once after a handoff is refused because the work is not on the PR, and not counted toward the revision cap.",
    inputSchema: {
      agent: z.string(),
      message: z.string().min(1),
      push_only: z.boolean().optional(),
    },
  },
  async ({ agent, message, push_only }) => {
    const found = agentFor(agent);
    if ("error" in found) return text(found.error ?? "", true);
    if (!snapshot.agentsWithSessions.includes(agent))
      return text(
        `${agent} has no conversation in this work item yet; use dispatch_agent.`,
        true,
      );
    return submit(
      {
        type: "follow_up",
        agent,
        agentType: found.agent.type,
        message,
        ...(push_only && { pushOnly: true }),
      },
      `Sent to ${agent}. End your turn now; its report will wake you.`,
    );
  },
);

server.registerTool(
  "post_update",
  {
    description:
      "Send a message to the requester (shown in the work item and mirrored to the source issue). Use one voice; never mention internal agents.",
    inputSchema: { message: z.string().min(1) },
  },
  async ({ message }) => submit({ type: "post_update", message }, "Posted."),
);

server.registerTool(
  "ask_human",
  {
    description:
      "Ask the requester a question and pause the work item until they answer. Batch questions into one call. Offer likely answers as options; the requester can pick one or write their own.",
    inputSchema: {
      question: z.string().min(1),
      options: z.array(z.string().min(1).max(200)).max(6).optional(),
    },
  },
  async ({ question, options }) =>
    submit(
      { type: "ask_human", question, ...(options?.length && { options }) },
      "Question queued in the factory inbox. End your turn.",
    ),
);

server.registerTool(
  "request_spec_approval",
  {
    description:
      "Ask the human to approve the drafted spec. Implementation is blocked until they approve.",
    inputSchema: { spec_pr_url: z.string().min(1), summary: z.string().min(1) },
  },
  async ({ spec_pr_url, summary }) =>
    submit(
      { type: "request_spec_approval", specPrUrl: spec_pr_url, summary },
      "Approval requested. End your turn; you will be woken with the decision.",
    ),
);

server.registerTool(
  "record_refs",
  {
    description:
      "Record the work item's tracking issue and/or pull request URL. Required before review and handoff.",
    inputSchema: {
      issue_url: z.string().optional(),
      pr_url: z.string().optional(),
    },
  },
  async ({ issue_url, pr_url }) =>
    submit(
      {
        type: "record_refs",
        ...(issue_url ? { issueUrl: issue_url } : {}),
        ...(pr_url ? { prUrl: pr_url } : {}),
      },
      "Recorded.",
    ),
);

server.registerTool(
  "handoff",
  {
    description:
      "Hand the finished pull request to the human for merge. Ends active work; completion follows the merge notification.",
    inputSchema: { pr_url: z.string().min(1), summary: z.string().min(1) },
  },
  async ({ pr_url, summary }) =>
    submit(
      { type: "handoff", prUrl: pr_url, summary },
      "Handoff requested; CI is checked before it is applied. End your turn.",
    ),
);

server.registerTool(
  "complete_task",
  {
    description:
      "Close the work item after its PR merged, or after answering a request that needed no PR. Idempotent.",
    inputSchema: { summary: z.string().min(1) },
  },
  async ({ summary }) =>
    submit({ type: "complete_task", summary }, "Completed."),
);

await server.connect(new StdioServerTransport());
