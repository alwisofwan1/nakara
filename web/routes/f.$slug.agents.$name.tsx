import * as Tabs from "@radix-ui/react-tabs";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  type AgentForm,
  ApiError,
  agentQuery,
  loadPage,
  reloadDefinition,
  saveAgent,
} from "../lib/api";
import { DeleteAgent } from "../features/agents/delete-agent";
import { ModelPicker } from "../features/agents/model-picker";
import { DetailRow } from "../ui/detail-row";
import { plural, problemKey, problemLocation } from "../lib/format";
import { Icon } from "../ui/icons";
import { useToast } from "../app/toast";

export const Route = createFileRoute("/f/$slug/agents/$name")({
  loader: ({ context, params }) =>
    loadPage(context.queryClient, agentQuery(params.slug, params.name)),
  component: Agent,
  staticData: { title: "Agents" },
});

type AgentData = Awaited<
  ReturnType<NonNullable<ReturnType<typeof agentQuery>["queryFn"]>>
>;

const sameForm = (a: AgentForm, b: AgentForm) =>
  JSON.stringify(a) === JSON.stringify(b);

function Agent() {
  const { slug, name } = Route.useParams();
  const client = useQueryClient();
  const toast = useToast();
  const { data } = useSuspenseQuery(agentQuery(slug, name));
  // Unsaved edits and the revision they started from; null shows the saved
  // values, so live refreshes never clobber a draft.
  const [draft, setDraft] = useState<{
    form: AgentForm;
    revision: string | null;
  } | null>(null);
  const form = draft?.form ?? data.form;
  const revision = draft ? draft.revision : data.revision;
  const dirty = Boolean(draft && !sameForm(draft.form, data.form));
  const edit = (change: Partial<AgentForm>) =>
    setDraft({ form: { ...form, ...change }, revision });
  const save = useMutation({
    mutationFn: (json: AgentForm) =>
      saveAgent(slug, name, { ...json, revision: revision ?? "" }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["agents"] });
      setDraft(null);
      toast(
        result.ok
          ? {
              title: "Agent saved",
              description: `The next ${name} run uses these settings.`,
              tone: "ok",
            }
          : result.errors.some((e) =>
                e.message.includes("waits for your approval"),
              )
            ? {
                title: "Saved; wider reach waits for approval",
                description:
                  "Approve it on the Definition page. The last approved definition is still running.",
                tone: "bad",
              }
            : {
                title: `Saved, but the reload failed: ${plural(result.errors.length, "error")}`,
                description: "The last valid definition is still running.",
                tone: "bad",
              },
      );
    },
  });
  const problems = save.error instanceof ApiError ? save.error.problems : [];
  const conflict =
    save.error instanceof ApiError && save.error.code === "conflict";
  // After a conflict, load the file as it is now; the stale draft is dropped.
  const reload = useMutation({
    mutationFn: () => reloadDefinition(slug),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["agents"] });
      void client.invalidateQueries({ queryKey: ["definition"] });
      setDraft(null);
      save.reset();
    },
  });

  return (
    <section>
      <Link
        to="/f/$slug/agents"
        params={{ slug }}
        className="text-small text-muted"
      >
        ← Agents
      </Link>
      <div className="my-lg flex flex-wrap items-center gap-md">
        <h1 className="text-heading font-semibold">{name}</h1>
        <div className="ml-auto flex gap-sm">
          {dirty && (
            <button
              type="button"
              className="ghost"
              disabled={save.isPending}
              onClick={() => {
                setDraft(null);
                save.reset();
              }}
            >
              Discard
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={!dirty || !revision || save.isPending}
            onClick={() => save.mutate(form)}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
      <p className="mb-lg text-muted">{data.description}</p>
      {data.gitTracked && (
        <p className="mb-lg flex gap-sm rounded-control bg-surface-muted p-md text-small">
          <Icon name="commit" className="icon" />
          This definition lives in a git-tracked folder. Save changes writes
          agents/{name}/agent.md on disk; commit it with git to keep it.
        </p>
      )}
      {save.error && (
        <div role="alert" className="banner bad mb-lg">
          <p className="flex items-start gap-sm font-semibold">
            <Icon name="circle-alert" className="icon" />
            {conflict
              ? `agents/${name}/agent.md changed on disk since this form was loaded. Reload to edit the new version; your unsaved changes will be discarded.`
              : save.error.message}
          </p>
          {conflict && (
            <button
              type="button"
              className="ghost justify-self-start"
              disabled={reload.isPending}
              onClick={() => reload.mutate()}
            >
              {reload.isPending ? "Reloading…" : "Reload"}
            </button>
          )}
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
      <Tabs.Root defaultValue="Prompt" key={name}>
        <Tabs.List className="agent-tabs" aria-label="Agent details">
          {["Prompt", "Automations", "Runs", "Settings"].map((tab) => (
            <Tabs.Trigger key={tab} value={tab}>
              {tab}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="Prompt" className="py-xl">
          <label className="field">
            <span className="sr-only">Prompt</span>
            <textarea
              className="input agent-prompt-input"
              value={form.prompt}
              rows={24}
              spellCheck={false}
              placeholder="No prompt defined."
              onChange={(e) => edit({ prompt: e.target.value })}
            />
          </label>
        </Tabs.Content>
        <Tabs.Content value="Automations">
          <ul>
            {data.automations.map((a) => (
              <li className="detail-row" key={a.name}>
                <strong>{a.name}</strong>
                <span>{a.enabled ? "Enabled" : "Disabled"}</span>
                <span className="text-muted">{a.triggers.join(", ")}</span>
              </li>
            ))}
          </ul>
          {!data.automations.length && (
            <p className="py-xl text-muted">No automations use this agent.</p>
          )}
        </Tabs.Content>
        <Tabs.Content value="Runs">
          <ul>
            {data.runs.map((r) => (
              <li key={r.id} className="detail-row">
                <Link
                  className="text-accent"
                  to="/runs/$runId"
                  params={{ runId: String(r.id) }}
                >
                  Run #{r.id}
                </Link>
                <span>{r.status}</span>
                <time dateTime={r.startedAt}>{r.startedAt}</time>
              </li>
            ))}
          </ul>
          {!data.runs.length && (
            <p className="py-xl text-muted">No runs for this agent.</p>
          )}
        </Tabs.Content>
        <Tabs.Content value="Settings">
          <Settings data={data} form={form} edit={edit} />
          <DeleteAgent slug={slug} name={name} revision={data.revision} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function Settings({
  data,
  form,
  edit,
}: {
  data: AgentData;
  form: AgentForm;
  edit: (change: Partial<AgentForm>) => void;
}) {
  const { defaults, options } = data;
  const readOnly = ["MCPs", "Skills", "Agent skills"];
  // Blank clears the setting; the server trims what is kept.
  const text = (value: string) => (value.trim() ? value : null);
  return (
    <dl>
      <DetailRow
        label="Name"
        hint="The folder name in agents/; it cannot change."
      >
        <span>{data.name}</span>
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
          onChange={(e) => edit({ description: text(e.target.value) })}
        />
      </DetailRow>
      {data.settings
        .filter((s) => readOnly.includes(s.name))
        .map((s) => (
          <DetailRow key={s.name} label={s.name}>
            {s.inherited && <span className="agent-chip mr-sm">Default</span>}
            {s.value}
          </DetailRow>
        ))}
      <DetailRow
        label="Model"
        hint="Listed live by each harness CLI, with the reasoning levels the model supports."
        inherited={form.harness === null && form.model === null}
      >
        <ModelPicker
          value={form}
          defaultHarness={defaults.harness}
          defaultLabel={`${defaults.harness} · ${defaults.model}`}
          onChange={edit}
        />
      </DetailRow>
      <DetailRow label="Runner" inherited={form.runner === null}>
        <select
          className="input"
          aria-label="Runner"
          value={form.runner ?? ""}
          onChange={(e) => edit({ runner: e.target.value || null })}
        >
          <option value="">Default ({defaults.runner})</option>
          {options.runners.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </DetailRow>
      <DetailRow label="Spawnable by" inherited={form.spawnableBy === null}>
        <select
          className="input"
          aria-label="Spawnable by"
          value={form.spawnableBy ? "some" : "any"}
          onChange={(e) =>
            edit({ spawnableBy: e.target.value === "any" ? null : [] })
          }
        >
          <option value="any">Default (any agent)</option>
          <option value="some">Only the agents checked below</option>
        </select>
        {form.spawnableBy?.length === 0 && (
          <p className="mt-sm text-small text-attention">
            No agent can spawn it. Check an agent, or choose Default.
          </p>
        )}
        {form.spawnableBy && (
          <fieldset className="mt-sm flex flex-wrap gap-md">
            <legend className="sr-only">Agents that may spawn it</legend>
            {options.agents.map((agent) => (
              <label key={agent} className="flex items-center gap-xs">
                <input
                  type="checkbox"
                  checked={form.spawnableBy?.includes(agent) ?? false}
                  onChange={(e) =>
                    edit({
                      spawnableBy: e.target.checked
                        ? [...(form.spawnableBy ?? []), agent]
                        : (form.spawnableBy ?? []).filter((a) => a !== agent),
                    })
                  }
                />
                {agent}
              </label>
            ))}
          </fieldset>
        )}
      </DetailRow>
      <DetailRow
        label="Idle timeout"
        hint="Minutes, 1 to 60."
        inherited={form.idleTimeoutMinutes === null}
      >
        <input
          className="input"
          aria-label="Idle timeout"
          type="number"
          min={1}
          max={60}
          value={form.idleTimeoutMinutes ?? ""}
          placeholder={`Default (${defaults.idleTimeoutMinutes})`}
          onChange={(e) =>
            edit({
              idleTimeoutMinutes:
                e.target.value === ""
                  ? null
                  : Math.trunc(Number(e.target.value)),
            })
          }
        />
      </DetailRow>
    </dl>
  );
}
