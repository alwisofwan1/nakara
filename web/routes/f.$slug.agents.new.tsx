import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { AgentType } from "../../src/web/api.ts";
import { AGENT_NAME } from "../features/agents/agent-name";
import { ApiError, createAgent, type NewAgent } from "../lib/api";
import { DetailRow } from "../ui/detail-row";
import { problemKey, problemLocation } from "../lib/format";
import { Icon } from "../ui/icons";
import { useToast } from "../app/toast";

export const Route = createFileRoute("/f/$slug/agents/new")({
  component: NewAgentPage,
  staticData: { title: "Agents" },
});

/** Every type a new agent can have; a factory has exactly one foreman. */
const TYPES = {
  CUSTOM: "Custom",
  TRIAGE: "Triage",
  SPEC: "Spec",
  IMPLEMENT: "Implement",
  REVIEW: "Review",
  VERIFY: "Verify",
  REFLECT: "Reflect",
} satisfies Record<Exclude<AgentType, "FOREMAN">, string>;

function NewAgentPage() {
  const { slug } = Route.useParams();
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState<NewAgent>({
    name: "",
    type: "CUSTOM",
    description: null,
    prompt: "",
  });
  const edit = (change: Partial<NewAgent>) => setForm({ ...form, ...change });
  const name = form.name.trim();
  const validName = AGENT_NAME.test(name);
  const create = useMutation({
    mutationFn: () => createAgent(slug, { ...form, name }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["agents"] });
      toast(
        result.ok
          ? {
              title: "Agent created",
              description: `agents/${result.name}/agent.md was written; the foreman can dispatch it now.`,
              tone: "ok",
            }
          : {
              title: "Created, but the reload failed",
              description: "The last valid definition is still running.",
              tone: "bad",
            },
      );
      await navigate({
        to: "/f/$slug/agents/$name",
        params: { slug, name: result.name },
      });
    },
  });
  const problems =
    create.error instanceof ApiError ? create.error.problems : [];

  return (
    <section>
      <Link
        to="/f/$slug/agents"
        params={{ slug }}
        className="text-small text-muted"
      >
        ← Agents
      </Link>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (validName) create.mutate();
        }}
      >
        <div className="my-lg flex flex-wrap items-center gap-md">
          <h1 className="text-heading font-semibold">New agent</h1>
          <div className="ml-auto flex gap-sm">
            <Link to="/f/$slug/agents" params={{ slug }} className="ghost">
              Cancel
            </Link>
            <button
              type="submit"
              className="primary"
              disabled={!validName || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create agent"}
            </button>
          </div>
        </div>
        {create.error && (
          <div role="alert" className="banner bad mb-lg">
            <p className="flex items-start gap-sm font-semibold">
              <Icon name="circle-alert" className="icon" />
              {create.error.message}
            </p>
            {problems.length > 0 && (
              <ul className="grid gap-xs">
                {problems.map((problem, index) => (
                  <li key={problemKey(problem, index)} className="problem">
                    <code>{problemLocation(problem)}</code> {problem.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <dl>
          <DetailRow
            label="Name"
            hint="The folder name in agents/; it cannot change after creation."
          >
            <input
              className="input"
              aria-label="Name"
              value={form.name}
              placeholder="docs-writer"
              autoComplete="off"
              spellCheck={false}
              required
              aria-invalid={Boolean(name) && !validName}
              onChange={(e) => edit({ name: e.target.value })}
            />
            {name && !validName ? (
              <p className="mt-sm text-small text-attention">
                Use lowercase letters, digits, - and _, starting with a letter
                or digit, and not <code>new</code>.
              </p>
            ) : (
              name && (
                <p className="field-hint mt-sm">
                  Writes agents/{name}/agent.md
                </p>
              )
            )}
          </DetailRow>
          <DetailRow
            label="Agent type"
            hint="The kind of job the foreman dispatches it for."
          >
            <select
              className="input"
              aria-label="Agent type"
              value={form.type}
              onChange={(e) =>
                edit({ type: e.target.value as NewAgent["type"] })
              }
            >
              {Object.entries(TYPES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </DetailRow>
          <DetailRow
            label="Description"
            hint="The foreman reads it to pick an agent."
          >
            <textarea
              className="input"
              aria-label="Description"
              rows={2}
              value={form.description ?? ""}
              onChange={(e) =>
                edit({
                  description: e.target.value.trim() ? e.target.value : null,
                })
              }
            />
          </DetailRow>
        </dl>
        <label className="field py-xl">
          <span className="field-label">Prompt</span>
          <textarea
            className="input agent-prompt-input"
            value={form.prompt}
            rows={16}
            spellCheck={false}
            placeholder="What this agent does and how it reports back."
            onChange={(e) => edit({ prompt: e.target.value })}
          />
        </label>
        <p className="text-small text-muted">
          Harness, model, runner and the other settings use the factory's
          defaults; change them on the agent's Settings tab after it is created.
        </p>
      </form>
    </section>
  );
}
