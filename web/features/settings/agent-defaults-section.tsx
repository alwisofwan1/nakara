import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useToast } from "../../app/toast";
import { ApiError, factorySettingsQuery, saveFactoryFile } from "../../lib/api";
import { problemKey, problemLocation } from "../../lib/format";
import { ModelPicker } from "../agents/model-picker";
import {
  type AgentDefaultsForm,
  agentDefaultsEdit,
  HARNESSES,
  harnessOf,
  isSandbox,
  type RunnerOption,
  type RevisionQueue,
  runnerFor,
} from "./agent-defaults";

/**
 * The everyday agentDefaults of factory.yaml: harness, model, runner and idle
 * timeout. Secrets and MCP servers stay in the file; a single agent keeps its
 * own editor. Saved together, with the revision the last save returned.
 */
export function AgentDefaultsSection({
  slug,
  file,
  runners,
  pendingReach,
  queue,
}: {
  slug: string;
  /** The page's one queue of factory.yaml saves, shared with the description. */
  queue: RevisionQueue;
  file: { agentDefaults: AgentDefaultsForm; revision: string };
  runners: RunnerOption[];
  /** What a saved edit adds to agents' reach, waiting for approval; null when nothing waits. */
  pendingReach: string[] | null;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const saved = file.agentDefaults;
  // Unsaved edits; null shows the saved values, so live refreshes never clobber a draft.
  const [draft, setDraft] = useState<AgentDefaultsForm | null>(null);
  const form = draft ?? saved;
  const edit = (change: Partial<AgentDefaultsForm>) =>
    setDraft({ ...form, ...change });
  const changes = draft && agentDefaultsEdit(saved, draft);
  const harness = harnessOf(form);
  const sandbox = isSandbox(form.runner, runners);
  const sameKind = runners.filter((r) => r.sandbox === sandbox);

  const save = useMutation({
    mutationFn: (agentDefaults: NonNullable<typeof changes>) =>
      queue.run((revision) =>
        saveFactoryFile(slug, { revision, agentDefaults }),
      ),
    onSuccess: (result, sent) => {
      client.setQueryData(factorySettingsQuery(slug).queryKey, (current) =>
        current?.factoryFile
          ? {
              ...current,
              factoryFile: {
                ...current.factoryFile,
                agentDefaults: {
                  ...current.factoryFile.agentDefaults,
                  ...sent,
                },
                revision: result.revision,
              },
            }
          : current,
      );
      setDraft(null);
      void client.invalidateQueries({ queryKey: ["agents", slug] });
      void client.invalidateQueries({ queryKey: ["definition"] });
      void client.invalidateQueries({
        queryKey: factorySettingsQuery(slug).queryKey,
      });
      toast(
        result.ok
          ? {
              title: "Agent defaults saved",
              description:
                "Agents without their own settings use them from their next run.",
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
                title: "Saved, but the reload failed",
                description: "The last valid definition is still running.",
                tone: "bad",
              },
      );
    },
  });
  const problems = save.error instanceof ApiError ? save.error.problems : [];

  return (
    <section
      className="box agent-defaults"
      aria-labelledby="settings-agent-defaults"
    >
      <h2 id="settings-agent-defaults" className="box-row font-semibold">
        Agent defaults
      </h2>
      <div className="box-row">
        <p className="text-muted">
          Used by every Agent that does not set its own. Change a single Agent
          in the{" "}
          <Link to="/f/$slug/agents" params={{ slug }} className="underline">
            Agents tab
          </Link>
          .
        </p>
      </div>
      <div className="box-row limit-row">
        <span id="agent-defaults-harness" className="field-label">
          Harness
        </span>
        <fieldset
          className="segmented"
          aria-labelledby="agent-defaults-harness"
          disabled={save.isPending}
        >
          {HARNESSES.map((option) => (
            <button
              key={option.harness}
              type="button"
              className="segmented-option"
              aria-pressed={harness === option.harness}
              onClick={() => {
                if (option.harness !== harness)
                  edit({ harness: option.harness, model: null, effort: null });
              }}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="box-row limit-row">
        <span className="field-label">Model</span>
        <ModelPicker
          value={{
            harness: form.harness ?? harness,
            model: form.model,
            effort: form.effort,
          }}
          defaultLabel="the harness's own model"
          defaultHarness={harness}
          onChange={(next) =>
            edit({
              harness: next.harness ?? harness,
              model: next.model,
              effort: next.effort,
            })
          }
        />
      </div>
      <div className="box-row">
        <div className="grid w-full gap-xs">
          <div className="limit-row">
            <span id="agent-defaults-runner" className="field-label">
              Runner
            </span>
            <fieldset
              className="segmented"
              aria-labelledby="agent-defaults-runner"
              disabled={save.isPending}
            >
              {[
                { sandbox: true, label: "Docker sandbox" },
                { sandbox: false, label: "Host" },
              ].map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className="segmented-option"
                  aria-pressed={sandbox === option.sandbox}
                  disabled={
                    option.sandbox && !runners.some((r) => r.sandbox === true)
                  }
                  onClick={() => {
                    if (option.sandbox !== sandbox)
                      edit({
                        runner: runnerFor(option.sandbox, form.runner, runners),
                      });
                  }}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>
          </div>
          {sameKind.length > 1 && (
            <div className="limit-row">
              <label
                htmlFor="agent-defaults-runner-file"
                className="field-hint"
              >
                Runner file
              </label>
              <select
                id="agent-defaults-runner-file"
                className="input w-auto"
                value={form.runner ?? ""}
                onChange={(event) => edit({ runner: event.target.value })}
              >
                {sameKind.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="text-muted">
            {sandbox
              ? "Each turn runs in a throwaway container that reaches only the hosts its runner allows."
              : "Agents work on this host with your permissions. Moving them here waits for your approval."}
          </p>
        </div>
      </div>
      <div className="box-row limit-row">
        <label htmlFor="agent-defaults-idle" className="field-label">
          Idle timeout
          <span className="field-hint">minutes</span>
        </label>
        <input
          id="agent-defaults-idle"
          className="input input-narrow"
          type="number"
          inputMode="numeric"
          min={1}
          max={60}
          placeholder="Default: 60"
          value={form.idleTimeoutMinutes ?? ""}
          onChange={(event) =>
            edit({
              idleTimeoutMinutes:
                event.target.value === ""
                  ? null
                  : Math.trunc(Number(event.target.value)),
            })
          }
        />
      </div>
      {pendingReach && (
        <div className="box-row">
          <section
            className="banner attention grid w-full gap-sm"
            aria-label="Wider reach waits for approval"
          >
            <p>
              The saved files let agents reach more than the running definition
              does. Nothing changes until you approve it on the{" "}
              <Link
                to="/f/$slug/definition"
                params={{ slug }}
                className="underline"
              >
                Definition page
              </Link>
              .
            </p>
            <ul className="grid gap-xs">
              {pendingReach.map((line) => (
                <li key={line}>
                  <code>+ {line}</code>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
      {(save.error || problems.length > 0) && (
        <div className="box-row" role="alert">
          <div className="grid gap-xs">
            {save.error && <p className="form-error">{save.error.message}</p>}
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
        </div>
      )}
      <div className="box-row justify-end">
        <button
          type="button"
          className="ghost"
          disabled={!changes || save.isPending}
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
          disabled={!changes || save.isPending}
          onClick={() => {
            if (changes) save.mutate(changes);
          }}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </section>
  );
}
