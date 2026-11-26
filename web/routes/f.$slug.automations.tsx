import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  ApiError,
  automationsQuery,
  reloadDefinition,
  runAutomation,
  saveAutomation,
} from "../lib/api";
import { plural, problemKey, problemLocation } from "../lib/format";
import { Icon } from "../ui/icons";
import { NewWorkDialog } from "../features/new-work/newWork";
import { automationPrefill } from "../features/new-work/prefill";
import { useToast } from "../app/toast";
import { AutomationForm, utc } from "../features/automations/automation-form";
import { DeleteAutomation } from "../features/automations/delete-automation";
import { NewAutomationForm } from "../features/automations/new-automation";

export const Route = createFileRoute("/f/$slug/automations")({
  // Started, not awaited: the page shows its frame and its own loading state.
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(automationsQuery(params.slug));
  },
  component: Automations,
  staticData: { title: "Automations" },
});

type Automation = NonNullable<
  Awaited<
    ReturnType<NonNullable<ReturnType<typeof automationsQuery>["queryFn"]>>
  >[number]
>;

function Automations() {
  const { slug } = Route.useParams();
  const client = useQueryClient();
  const toast = useToast();
  const { data, isError, refetch } = useQuery(automationsQuery(slug));
  const [selected, setSelected] = useState<string | null>(null);
  const current = data?.find((automation) => automation.name === selected);
  // New automation opens the drawer empty instead of on a row.
  const [creating, setCreating] = useState(false);
  // Run now for an event-triggered automation opens New work on it.
  const [newWork, setNewWork] = useState<string | null>(null);
  // Unsaved instructions and the revision they started from; null shows the
  // saved text, so live refreshes never clobber a draft.
  const [draft, setDraft] = useState<{
    name: string;
    instructions: string;
    revision: string | null;
  } | null>(null);
  // Bumped by Reload, so the settings form starts again from the file.
  const [reloads, setReloads] = useState(0);
  const instructions =
    draft && draft.name === current?.name
      ? draft.instructions
      : (current?.instructions ?? "");
  const dirty = Boolean(current && instructions !== current.instructions);
  const saved = (ok: boolean, errors: number, title: string) =>
    toast(
      ok
        ? { title, tone: "ok" }
        : {
            title: `Saved, but the reload failed: ${plural(errors, "error")}`,
            description: "The last valid definition is still running.",
            tone: "bad",
          },
    );
  const toggle = useMutation({
    mutationFn: ({
      automation,
      enabled,
    }: {
      automation: Automation;
      enabled: boolean;
    }) =>
      saveAutomation(slug, automation.name, {
        enabled,
        revision: automation.revision ?? "",
      }),
    onSuccess: async (result, { automation, enabled }) => {
      // A draft of the same file continues from the file as it is now.
      setDraft((d) =>
        d?.name === automation.name && d.revision === automation.revision
          ? { ...d, revision: result.revision }
          : d,
      );
      await client.invalidateQueries({ queryKey: ["automations"] });
      saved(
        result.ok,
        result.errors.length,
        `${automation.displayName} ${enabled ? "enabled" : "disabled"}`,
      );
    },
    onError: (error) =>
      toast({
        title: "The switch was not saved",
        description: error.message,
        tone: "bad",
        // A file changed on disk: load it as it is now, then switch again.
        ...(error instanceof ApiError &&
          error.code === "conflict" && {
            action: { label: "Reload", onClick: () => reload.mutate() },
          }),
      }),
  });
  const save = useMutation({
    mutationFn: ({
      name,
      text,
      revision,
    }: {
      name: string;
      text: string;
      revision: string;
    }) => saveAutomation(slug, name, { instructions: text, revision }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["automations"] });
      setDraft(null);
      saved(result.ok, result.errors.length, "Instructions saved");
    },
  });
  const problems = save.error instanceof ApiError ? save.error.problems : [];
  const conflict =
    save.error instanceof ApiError && save.error.code === "conflict";
  // After a conflict, load the file as it is now; the stale draft is dropped.
  const reload = useMutation({
    mutationFn: () => reloadDefinition(slug),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["automations"] });
      setDraft(null);
      save.reset();
      setReloads((n) => n + 1);
    },
  });
  const run = useMutation({
    mutationFn: (name: string) => runAutomation(slug, name),
    onSuccess: async (item) => {
      await client.invalidateQueries({ queryKey: ["automations"] });
      toast({
        title: `Work item #${item.id} created`,
        description: item.title,
        tone: "ok",
      });
    },
    onError: (error) =>
      toast({
        title: "Run now failed",
        description: error.message,
        tone: "bad",
      }),
  });
  const select = (name: string) => {
    setCreating(false);
    if (name === selected) return;
    setSelected(name);
    setDraft(null);
    save.reset();
  };
  const enabledSwitch = (
    automation: Automation,
    label = `${automation.displayName} enabled`,
  ) => (
    <input
      type="checkbox"
      role="switch"
      aria-checked={automation.enabled}
      aria-label={label}
      checked={automation.enabled}
      disabled={!automation.revision || toggle.isPending}
      title={automation.revision ? undefined : "Not defined in a file"}
      className="automation-switch"
      onClick={(event) => event.stopPropagation()}
      onChange={(event) =>
        toggle.mutate({ automation, enabled: event.target.checked })
      }
    />
  );
  return (
    <section>
      <div className="mb-md flex flex-wrap items-center gap-md">
        <h1 className="text-heading font-semibold">Automations</h1>
        <button
          type="button"
          className="primary ml-auto"
          aria-expanded={creating}
          onClick={() => {
            setSelected(null);
            setDraft(null);
            save.reset();
            setCreating(true);
          }}
        >
          New automation
        </button>
      </div>
      <p className="mb-xl text-muted">
        When something happens, create a work item with these instructions.
        Defined in factory/automations/*.
      </p>
      {isError && (
        <p role="alert">
          Unable to load automations.{" "}
          <button
            type="button"
            className="ghost"
            onClick={() => void refetch()}
          >
            Retry
          </button>
        </p>
      )}
      {!data && !isError && <p role="status">Loading automations…</p>}
      {data?.length === 0 && <p>No automations defined.</p>}
      <div className="automations-layout">
        {Boolean(data?.length) && (
          <div className="automation-table-wrap">
            <table className="automation-table">
              <caption className="sr-only">Factory automations</caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Trigger</th>
                  <th>Last / next</th>
                  <th>Items</th>
                  <th>On</th>
                </tr>
              </thead>
              <tbody>
                {data?.map((automation) => {
                  const schedules = automation.triggers.filter(
                    (trigger) => trigger.cron,
                  );
                  const next = schedules
                    .map((trigger) => trigger.nextFire)
                    .filter((value): value is string => value !== null)
                    .sort()[0];
                  const last = automation.recentItems[0];
                  return (
                    <tr
                      key={automation.name}
                      data-selected={selected === automation.name}
                      onClick={() => select(automation.name)}
                    >
                      <td>
                        <button
                          type="button"
                          id={`automation-${automation.name}`}
                          className="automation-name"
                          onClick={() => select(automation.name)}
                          aria-expanded={selected === automation.name}
                        >
                          {automation.displayName}
                        </button>
                        <p className="automation-description">
                          {automation.description}
                        </p>
                      </td>
                      <td>
                        <div className="flex flex-wrap gap-xs">
                          {automation.triggers.map((trigger) => (
                            <span
                              className="trigger-chip"
                              key={JSON.stringify(trigger)}
                            >
                              {trigger.cron
                                ? `cron · ${trigger.cron}`
                                : `${trigger.provider} · ${trigger.event.replaceAll("_", " ")}`}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="automation-when" data-label="Last / next">
                        {schedules.length ? (
                          <>
                            {!automation.enabled && (
                              <span className="block text-muted">
                                Disabled · schedule next
                              </span>
                            )}
                            {next ? (
                              <time dateTime={next}>{utc(next)}</time>
                            ) : (
                              "No match within 5 years"
                            )}
                          </>
                        ) : last ? (
                          <>
                            <span className="block">#{last.id}</span>
                            <time dateTime={last.createdAt}>
                              {utc(last.createdAt)}
                            </time>
                          </>
                        ) : (
                          "No items yet"
                        )}
                      </td>
                      <td data-label="Items">{automation.itemCount}</td>
                      <td>{enabledSwitch(automation)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Dialog.Root
          open={Boolean(current) || creating}
          modal={false}
          onOpenChange={(open) => {
            if (!open) {
              setCreating(false);
              setSelected(null);
              setDraft(null);
              save.reset();
            }
          }}
        >
          {creating && (
            <Dialog.Content
              className="automation-pane"
              aria-describedby={undefined}
              onInteractOutside={(event) => event.preventDefault()}
            >
              <div className="flex items-center justify-between gap-md">
                <Dialog.Title className="font-semibold">
                  New automation
                </Dialog.Title>
                <Dialog.Close
                  className="ghost"
                  aria-label="Close new automation"
                >
                  Close
                </Dialog.Close>
              </div>
              <NewAutomationForm
                slug={slug}
                onCreated={(name) => select(name)}
                onCancel={() => setCreating(false)}
              />
            </Dialog.Content>
          )}
          {current && !creating && (
            <Dialog.Content
              className="automation-pane"
              aria-describedby={undefined}
              onInteractOutside={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                document.getElementById(`automation-${current.name}`)?.focus();
              }}
            >
              <div className="flex items-center justify-between gap-md">
                <Dialog.Title className="font-semibold">
                  {current.displayName}
                </Dialog.Title>
                <div className="flex gap-sm">
                  {/* A disabled button shows no tooltip of its own. */}
                  <span
                    title={
                      current.enabled
                        ? undefined
                        : "Disabled automations do not run. Turn it on to run it now."
                    }
                  >
                    <button
                      type="button"
                      className="primary"
                      disabled={!current.enabled || run.isPending}
                      aria-describedby={
                        current.enabled ? undefined : "run-now-disabled"
                      }
                      onClick={() =>
                        current.triggers.some((trigger) => trigger.cron)
                          ? run.mutate(current.name)
                          : setNewWork(current.name)
                      }
                    >
                      {run.isPending ? "Starting…" : "Run now"}
                    </button>
                  </span>
                  <Dialog.Close
                    className="ghost"
                    aria-label="Close automation details"
                  >
                    Close
                  </Dialog.Close>
                </div>
              </div>
              {!current.enabled && (
                <p id="run-now-disabled" className="text-small text-muted">
                  Disabled automations do not run. Turn it on to run it now.
                </p>
              )}
              <AutomationForm
                key={`${current.name}:${reloads}`}
                slug={slug}
                automation={current}
                onSaved={(revision) =>
                  // A draft of the same file continues from the file as it is now.
                  setDraft((d) =>
                    d?.name === current.name && d.revision === current.revision
                      ? { ...d, revision }
                      : d,
                  )
                }
                onConflict={() => reload.mutate()}
              />
              <section>
                <h2 className="pane-heading">
                  <label htmlFor="automation-instructions">
                    Instructions (automation.md)
                  </label>
                </h2>
                <textarea
                  id="automation-instructions"
                  className="input agent-prompt-input w-full"
                  value={instructions}
                  rows={10}
                  spellCheck={false}
                  placeholder="No instructions."
                  disabled={!current.revision}
                  onChange={(e) =>
                    setDraft({
                      name: current.name,
                      instructions: e.target.value,
                      revision:
                        draft?.name === current.name
                          ? draft.revision
                          : current.revision,
                    })
                  }
                />
                {save.error && (
                  <div role="alert" className="banner bad mt-sm">
                    <p className="flex items-start gap-sm font-semibold">
                      <Icon name="circle-alert" className="icon" />
                      {conflict
                        ? `automations/${current.name}/automation.md changed on disk since this pane was loaded. Reload to edit the new version; your unsaved changes will be discarded.`
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
                          <li
                            key={problemKey(problem, index)}
                            className="problem"
                          >
                            <code>{problemLocation(problem)}</code>{" "}
                            {problem.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {dirty && (
                  <div className="mt-sm flex justify-end gap-sm">
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
                      type="button"
                      className="primary"
                      disabled={save.isPending}
                      onClick={() =>
                        save.mutate({
                          name: current.name,
                          text: instructions,
                          revision:
                            (draft?.name === current.name && draft.revision) ||
                            current.revision ||
                            "",
                        })
                      }
                    >
                      {save.isPending ? "Saving…" : "Save instructions"}
                    </button>
                  </div>
                )}
              </section>
              <section>
                <h2 className="pane-heading">Settings</h2>
                <dl className="automation-settings">
                  <dt>Runner</dt>
                  <dd>{current.runner ?? "Agent default"}</dd>
                  <dt>Model</dt>
                  <dd>{current.model ?? "Agent default"}</dd>
                  <dt>Idle timeout</dt>
                  <dd>
                    {current.idleTimeoutMinutes
                      ? `${current.idleTimeoutMinutes} minutes`
                      : "Agent default"}
                  </dd>
                  <dt>Enabled</dt>
                  <dd>{enabledSwitch(current, "Enabled")}</dd>
                </dl>
              </section>
              <section>
                <h2 className="pane-heading">Recent items</h2>
                {current.recentItems.length ? (
                  <ul className="grid gap-md">
                    {current.recentItems.map((item) => (
                      <li key={item.id}>
                        <Link
                          className="text-accent hover:underline"
                          to="/items/$itemId"
                          params={{ itemId: String(item.id) }}
                        >
                          #{item.id} {item.title}
                        </Link>
                        <span className="block text-small text-muted">
                          {item.stage}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted">No items yet.</p>
                )}
              </section>
              <DeleteAutomation
                key={current.name}
                slug={slug}
                name={current.name}
                revision={current.revision}
                onDeleted={() => {
                  setSelected(null);
                  setDraft(null);
                }}
                onConflict={() => reload.mutate()}
              />
            </Dialog.Content>
          )}
        </Dialog.Root>
      </div>
      {newWork && (
        <NewWorkDialog
          slug={slug}
          open
          onOpenChange={(open) => {
            if (!open) setNewWork(null);
          }}
          prefill={automationPrefill(newWork)}
        />
      )}
    </section>
  );
}
