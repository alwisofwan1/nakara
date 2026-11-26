import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, agentsQuery, createAutomation } from "../../lib/api";
import { problemKey, problemLocation } from "../../lib/format";
import { Icon } from "../../ui/icons";
import { useToast } from "../../app/toast";
import { AUTOMATION_NAME, slugify } from "./automation-name";
import {
  TriggerFields,
  type TriggerForm,
  triggerOf,
  useTriggerCheck,
} from "./automation-form";

interface Form extends TriggerForm {
  displayName: string;
  /** The folder name; null follows the display name. */
  name: string | null;
  agent: string | null;
  instructions: string;
  enabled: boolean;
}

const EMPTY: Form = {
  displayName: "",
  name: null,
  kind: null,
  label: "",
  cron: "",
  members: "",
  agent: null,
  instructions: "",
  enabled: true,
};

/**
 * The drawer of New automation: writes automations/<name>/automation.md. The
 * folder name follows the display name until it is edited.
 */
export function NewAutomationForm({
  slug,
  onCreated,
  onCancel,
}: {
  slug: string;
  onCreated: (name: string) => void;
  onCancel: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Form>(EMPTY);
  const edit = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const agents = useQuery(agentsQuery(slug));
  const foreman =
    agents.data?.find((a) => a.type === "FOREMAN")?.name ??
    agents.data?.[0]?.name;
  const agent = form.agent ?? foreman ?? "";
  const name = (form.name ?? slugify(form.displayName)).trim();
  const validName = AUTOMATION_NAME.test(name);
  const check = useTriggerCheck(slug, form);
  const trigger = triggerOf(form);
  const ready = validName && trigger && !check.incomplete && agent;
  const create = useMutation({
    mutationFn: () =>
      createAutomation(slug, {
        name,
        displayName: form.displayName.trim() || null,
        // biome-ignore lint/style/noNonNullAssertion: Submit is disabled until a trigger is chosen.
        trigger: trigger!,
        agent,
        instructions: form.instructions,
        enabled: form.enabled,
      }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["automations"] });
      toast(
        result.ok
          ? {
              title: "Automation created",
              description: `automations/${result.name}/automation.md was written.`,
              tone: "ok",
            }
          : {
              title: "Created, but the reload failed",
              description: "The last valid definition is still running.",
              tone: "bad",
            },
      );
      onCreated(result.name);
    },
  });
  const problems =
    create.error instanceof ApiError ? create.error.problems : [];

  return (
    <form
      className="grid gap-lg"
      aria-label="New automation"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) create.mutate();
      }}
    >
      <label className="field">
        <span className="field-label">Display name</span>
        <input
          className="input"
          value={form.displayName}
          placeholder="Nightly report"
          onChange={(e) => edit({ displayName: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field-label">
          Name
          <span className="field-hint">Folder in automations/</span>
        </span>
        <input
          className="input font-mono"
          value={form.name ?? slugify(form.displayName)}
          placeholder="nightly-report"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(name) && !validName}
          aria-describedby="new-automation-name-hint"
          onChange={(e) => edit({ name: e.target.value })}
        />
        <span
          id="new-automation-name-hint"
          className={
            name && !validName
              ? "text-small text-attention"
              : "text-small text-muted"
          }
        >
          {name && !validName
            ? "Use lowercase letters, digits, - and _, starting with a letter or digit."
            : name
              ? `Writes automations/${name}/automation.md; it cannot change after creation.`
              : "Defaults from the display name; it cannot change after creation."}
        </span>
      </label>

      <section className="grid gap-sm">
        <h2 className="pane-heading">Trigger</h2>
        <TriggerFields form={form} edit={edit} disabled={false} check={check} />
        {!form.kind && <p className="field-hint">Choose what starts it.</p>}
      </section>

      <label className="field">
        <span className="field-label">Starts with</span>
        <select
          className="input"
          value={agent}
          onChange={(e) => edit({ agent: e.target.value })}
        >
          {agents.data?.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        <span className="field-hint">
          Usually the Foreman. Pick another agent to skip straight to its job.
        </span>
      </label>

      <label className="field">
        <span className="field-label">Instructions (automation.md)</span>
        <textarea
          className="input agent-prompt-input w-full"
          value={form.instructions}
          rows={8}
          spellCheck={false}
          placeholder="What the work item asks for."
          onChange={(e) => edit({ instructions: e.target.value })}
        />
      </label>

      <label className="flex items-center gap-sm">
        <input
          type="checkbox"
          role="switch"
          className="automation-switch"
          aria-checked={form.enabled}
          checked={form.enabled}
          onChange={(e) => edit({ enabled: e.target.checked })}
        />
        Enabled
      </label>

      {create.error && (
        <div role="alert" className="banner bad">
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
      <div className="flex justify-end gap-sm">
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="primary"
          disabled={!ready || create.isPending}
        >
          {create.isPending ? "Creating…" : "Create automation"}
        </button>
      </div>
    </form>
  );
}
