import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import {
  ApiError,
  type AutomationSave,
  agentsQuery,
  type automationsQuery,
  cronPreviewQuery,
  saveAutomation,
} from "../../lib/api";
import { plural, problemKey, problemLocation } from "../../lib/format";
import { Icon } from "../../ui/icons";
import { useToast } from "../../app/toast";

type Automation = NonNullable<
  Awaited<
    ReturnType<NonNullable<ReturnType<typeof automationsQuery>["queryFn"]>>
  >[number]
>;
type Trigger = Automation["triggers"][number];
type Kind = NonNullable<AutomationSave["trigger"]>["kind"];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: "github_label", label: "GitHub label" },
  { kind: "schedule", label: "Schedule" },
  { kind: "slack", label: "Slack" },
  { kind: "telegram", label: "Telegram" },
];

export const utc = (value: string) =>
  `${value.slice(0, 16).replace("T", " ")} UTC`;

const list = (value: unknown): string[] =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value.map(String)
      : typeof value === "object" && "in" in value
        ? list((value as { in: unknown }).in)
        : [String(value)];

const kindOf = (t: Trigger): Kind | null =>
  t.provider === "github" && t.event === "issue_labeled"
    ? "github_label"
    : t.provider === "schedule" && t.event === "cron_fired"
      ? "schedule"
      : t.provider === "slack" && t.event === "message"
        ? "slack"
        : t.provider === "telegram" && t.event === "message"
          ? "telegram"
          : null;

interface Form {
  displayName: string;
  kind: Kind | null;
  label: string;
  cron: string;
  members: string;
  agent: string;
}

function initial(automation: Automation): Form {
  const [trigger] = automation.triggers;
  const kind = trigger ? kindOf(trigger) : null;
  return {
    displayName: automation.displayName,
    kind,
    label:
      kind === "github_label" ? (list(trigger?.filter.labels)[0] ?? "") : "",
    cron: trigger?.cron ?? "",
    members: kind === "slack" ? list(trigger?.filter.members).join(", ") : "",
    agent: automation.agent,
  };
}

const memberIds = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** Why the drawer cannot change the triggers, or null when it can. */
function readOnly(automation: Automation): string | null {
  if (automation.triggers.length > 1)
    return "Edit automation.md to change several triggers";
  const [trigger] = automation.triggers;
  if (
    trigger &&
    kindOf(trigger) === "github_label" &&
    list(trigger.filter.labels).length > 1
  )
    return "Edit automation.md to change several labels";
  return null;
}

/** Only the fields that differ from the file; an untouched trigger is not sent. */
function changes(
  form: Form,
  saved: Form,
  name: string,
): Omit<AutomationSave, "revision"> {
  const edit: Omit<AutomationSave, "revision"> = {};
  // An empty name shows the folder name.
  if ((form.displayName.trim() || name) !== saved.displayName)
    edit.displayName = form.displayName.trim() || null;
  if (form.agent !== saved.agent) edit.agent = form.agent;
  const triggerChanged =
    form.kind !== saved.kind ||
    (form.kind === "github_label" && form.label.trim() !== saved.label) ||
    (form.kind === "schedule" && form.cron.trim() !== saved.cron) ||
    (form.kind === "slack" &&
      memberIds(form.members).join() !== memberIds(saved.members).join());
  if (triggerChanged && form.kind)
    edit.trigger =
      form.kind === "github_label"
        ? { kind: form.kind, label: form.label.trim() }
        : form.kind === "schedule"
          ? { kind: form.kind, cron: form.cron.trim() }
          : form.kind === "slack"
            ? { kind: form.kind, members: memberIds(form.members) }
            : { kind: form.kind };
  return edit;
}

/**
 * The drawer's Name, Trigger and Starts with. Only the changed fields are
 * sent, so a draft survives the enabled switch and live refreshes.
 */
export function AutomationForm({
  slug,
  automation,
  onSaved,
  onConflict,
}: {
  slug: string;
  automation: Automation;
  /** The file now has `revision`; an instructions draft continues from it. */
  onSaved: (revision: string) => void;
  onConflict: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const saved = initial(automation);
  // Null until the first edit, so the form follows the file until then.
  const [draft, setDraft] = useState<Form | null>(null);
  const form = draft ?? saved;
  const edit = (patch: Partial<Form>) => setDraft({ ...form, ...patch });
  const locked = readOnly(automation);
  const editable = Boolean(automation.revision);
  const agents = useQuery(agentsQuery(slug));
  const cron = useDeferredValue(form.cron.trim());
  const preview = useQuery({
    ...cronPreviewQuery(slug, cron),
    enabled: form.kind === "schedule" && cron !== "",
    placeholderData: keepPreviousData,
  });
  const invalidCron =
    form.kind === "schedule" &&
    (form.cron.trim() === "" || preview.data?.valid === false);
  const pending = changes(form, saved, automation.name);
  const dirty = Object.keys(pending).length > 0;
  const incomplete =
    invalidCron ||
    (form.kind === "github_label" && !form.label.trim()) ||
    (form.kind === "slack" && memberIds(form.members).length === 0);
  const save = useMutation({
    mutationFn: () =>
      saveAutomation(slug, automation.name, {
        ...pending,
        revision: automation.revision ?? "",
      }),
    onSuccess: async (result) => {
      onSaved(result.revision);
      await client.invalidateQueries({ queryKey: ["automations"] });
      setDraft(null);
      toast(
        result.ok
          ? { title: "Automation saved", tone: "ok" }
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
  const agentNames = agents.data?.map((a) => a.name) ?? [automation.agent];

  return (
    <form
      className="grid gap-lg"
      aria-label="Automation settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !incomplete) save.mutate();
      }}
    >
      <label className="field">
        <span className="field-label">
          Name
          <span className="field-hint">automations/{automation.name}</span>
        </span>
        <input
          className="input"
          value={form.displayName}
          placeholder={automation.name}
          disabled={!editable}
          onChange={(e) => edit({ displayName: e.target.value })}
        />
      </label>

      <section className="grid gap-sm">
        <h2 className="pane-heading">Trigger</h2>
        {locked ? (
          <>
            {automation.triggers.map((trigger) => (
              <TriggerSummary key={JSON.stringify(trigger)} trigger={trigger} />
            ))}
            <p className="field-hint">{locked}</p>
          </>
        ) : (
          <>
            <fieldset
              className="flex flex-wrap gap-xs"
              aria-label="Trigger"
              disabled={!editable}
            >
              {KINDS.map(({ kind, label }) => (
                <button
                  key={kind}
                  type="button"
                  className="kind-pill"
                  aria-pressed={form.kind === kind}
                  onClick={() => edit({ kind })}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            {!form.kind &&
              automation.triggers.map((trigger) => (
                <TriggerSummary
                  key={JSON.stringify(trigger)}
                  trigger={trigger}
                />
              ))}
            {form.kind === "github_label" && (
              <label className="field">
                <span className="field-label">
                  Label
                  <span className="field-hint">
                    Labeling an issue with it creates a work item.
                  </span>
                </span>
                <input
                  className="input"
                  value={form.label}
                  disabled={!editable}
                  onChange={(e) => edit({ label: e.target.value })}
                />
              </label>
            )}
            {form.kind === "schedule" && (
              <label className="field">
                <span className="field-label">
                  Schedule
                  <span className="field-hint">
                    Cron, 5 fields or @daily, in UTC
                  </span>
                </span>
                <input
                  className="input font-mono"
                  value={form.cron}
                  placeholder="0 9 * * 1"
                  spellCheck={false}
                  disabled={!editable}
                  aria-invalid={invalidCron}
                  aria-describedby="automation-cron-preview"
                  onChange={(e) => edit({ cron: e.target.value })}
                />
                <span
                  id="automation-cron-preview"
                  className={
                    invalidCron
                      ? "text-small text-bad"
                      : "text-small text-muted"
                  }
                >
                  {invalidCron
                    ? "Not a valid schedule"
                    : preview.data?.valid
                      ? preview.data.nextFire
                        ? `Next run: ${utc(preview.data.nextFire)}`
                        : "Never runs within 5 years"
                      : "Checking…"}
                </span>
              </label>
            )}
            {form.kind === "slack" && (
              <label className="field">
                <span className="field-label">
                  Slack member IDs
                  <span className="field-hint">
                    Profile → ⋯ → Copy member ID; separate with commas
                  </span>
                </span>
                <input
                  className="input font-mono"
                  value={form.members}
                  placeholder="U0123ABC, U0456DEF"
                  spellCheck={false}
                  disabled={!editable}
                  onChange={(e) => edit({ members: e.target.value })}
                />
              </label>
            )}
            {form.kind === "telegram" && (
              <p className="field-hint">
                A message from the trusted Telegram chat creates a work item.
              </p>
            )}
          </>
        )}
      </section>

      <label className="field">
        <span className="field-label">Starts with</span>
        <select
          className="input"
          value={form.agent}
          disabled={!editable}
          aria-describedby="automation-agent-hint"
          onChange={(e) => edit({ agent: e.target.value })}
        >
          {agentNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span id="automation-agent-hint" className="field-hint">
          Usually the Foreman. Pick another agent to skip straight to its job.
        </span>
      </label>

      {save.error && (
        <div role="alert" className="banner bad">
          <p className="flex items-start gap-sm font-semibold">
            <Icon name="circle-alert" className="icon" />
            {conflict
              ? `automations/${automation.name}/automation.md changed on disk since this pane was loaded. Reload to edit the new version; your unsaved changes will be discarded.`
              : save.error.message}
          </p>
          {conflict && (
            <button
              type="button"
              className="ghost justify-self-start"
              onClick={onConflict}
            >
              Reload
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
      {dirty && (
        <div className="flex justify-end gap-sm">
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
          <button
            type="submit"
            className="primary"
            disabled={save.isPending || incomplete}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      )}
    </form>
  );
}

function TriggerSummary({ trigger }: { trigger: Trigger }) {
  return (
    <div>
      <p>
        {trigger.provider} · {trigger.event.replaceAll("_", " ")}
      </p>
      {trigger.cron && <p className="text-small">{trigger.cron} · UTC</p>}
      {trigger.nextFire && (
        <p className="text-small">Next schedule: {utc(trigger.nextFire)}</p>
      )}
      {Object.entries(trigger.filter).map(([key, value]) => (
        <p key={key} className="text-small text-muted">
          {key}: {JSON.stringify(value)}
        </p>
      ))}
    </div>
  );
}
