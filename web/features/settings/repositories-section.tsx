import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useToast } from "../../app/toast";
import { ApiError, factorySettingsQuery, saveFactoryFile } from "../../lib/api";
import { problemKey } from "../../lib/format";
import type { RevisionQueue } from "./agent-defaults";
import {
  parseRepo,
  type RepoChange,
  refusedAt,
  repoOf,
  repoRows,
} from "./repositories";

/**
 * The repositories of factory.yaml: one row each with a remove button, and an
 * "Add repository" input. Each change saves at once, with the revision the
 * last save returned; a refused one shows its reason where it was made.
 */
export function RepositoriesSection({
  slug,
  file,
  pendingReach,
  queue,
}: {
  slug: string;
  file: {
    repositories: string[];
    /** The `verify` commands of each repository that lists any, keyed `owner/name`. */
    verify?: Record<string, string[]>;
    revision: string;
  };
  /** What a saved edit adds to agents' reach, waiting for approval; null when nothing waits. */
  pendingReach: string[] | null;
  /** The page's one queue of factory.yaml saves. */
  queue: RevisionQueue;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [input, setInput] = useState("");
  const parsed = parseRepo(input, file.repositories);
  const save = useMutation({
    mutationFn: (change: RepoChange) =>
      queue.run((revision) =>
        saveFactoryFile(slug, {
          revision,
          repositories:
            "add" in change
              ? { add: [change.add] }
              : { remove: [change.remove] },
        }),
      ),
    onSuccess: (result, change) => {
      const repo = repoOf(change);
      client.setQueryData(factorySettingsQuery(slug).queryKey, (current) =>
        current?.factoryFile
          ? {
              ...current,
              factoryFile: {
                ...current.factoryFile,
                repositories:
                  "add" in change
                    ? [...current.factoryFile.repositories, repo]
                    : current.factoryFile.repositories.filter(
                        (r) => r !== repo,
                      ),
                revision: result.revision,
              },
            }
          : current,
      );
      if ("add" in change) setInput("");
      void client.invalidateQueries({ queryKey: ["definition"] });
      void client.invalidateQueries({
        queryKey: factorySettingsQuery(slug).queryKey,
      });
      toast(
        result.ok
          ? {
              title:
                "add" in change ? "Repository added" : "Repository removed",
              description:
                "add" in change
                  ? `New Work Items can target ${repo}.`
                  : `New Work Items can no longer target ${repo}.`,
              tone: "ok",
            }
          : result.errors.some((e) =>
                e.message.includes("waits for your approval"),
              )
            ? {
                title: "Saved; the new repository waits for approval",
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
  const failed = save.error ? save.variables : undefined;
  /** The refusal of the last save, shown under the row or input it came from. */
  const refusal = (place: "add" | string) =>
    save.error && refusedAt(failed, place) ? (
      <Refusal error={save.error} />
    ) : null;
  const add = () => {
    if (parsed && "repo" in parsed) save.mutate({ add: parsed.repo });
  };

  return (
    <section className="box" aria-labelledby="settings-repositories">
      <h2 id="settings-repositories" className="box-row font-semibold">
        Repositories
      </h2>
      <div className="box-row">
        <p className="text-muted">
          A repository belongs to one factory. Each Work Item targets one of
          these.
        </p>
      </div>
      <ul aria-label="Repositories" className="grid border-t-0">
        {repoRows(file.repositories, pendingReach, file.verify).map((row) => (
          <li key={row.repo} className="box-row grid gap-xs">
            <div className="flex flex-wrap items-center gap-md">
              <code className="flex-1">{row.repo}</code>
              {row.pending && (
                <span className="chip text-attention">
                  Waits for approval on the{" "}
                  <Link
                    to="/f/$slug/definition"
                    params={{ slug }}
                    className="underline"
                  >
                    Definition page
                  </Link>
                </span>
              )}
              <button
                type="button"
                className="ghost"
                aria-label={`Remove ${row.repo}`}
                title={
                  row.removable
                    ? undefined
                    : "A factory needs at least one repository"
                }
                disabled={!row.removable || save.isPending}
                onClick={() => save.mutate({ remove: row.repo })}
              >
                Remove
              </button>
            </div>
            {!row.removable && (
              <p className="text-small text-muted">
                A factory keeps at least one repository; add another before
                removing this one.
              </p>
            )}
            {row.verify.length > 0 && (
              <div className="grid gap-xs">
                <p className="text-small text-muted">
                  Verify: Nakara runs these on the PR head after each
                  implementation run, in order, and stops at the first failure.
                  Edit them in factory.yaml.
                </p>
                <ol
                  aria-label={`Verify commands of ${row.repo}`}
                  className="grid gap-xs text-small"
                >
                  {row.verify.map((command, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: The same command may run twice; the list is read-only.
                    <li key={index}>
                      <code>{command}</code>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {refusal(row.repo)}
          </li>
        ))}
      </ul>
      <form
        className="box-row grid gap-xs"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label htmlFor="settings-add-repository" className="field-label">
          Add repository
        </label>
        <div className="flex flex-wrap items-center gap-sm">
          <input
            id="settings-add-repository"
            className="input flex-1"
            placeholder="owner/name"
            autoComplete="off"
            spellCheck={false}
            value={input}
            aria-invalid={Boolean(parsed && "error" in parsed)}
            onChange={(event) => {
              setInput(event.target.value);
              if (refusedAt(failed, "add")) save.reset();
            }}
          />
          <button
            type="submit"
            className="ghost"
            disabled={!parsed || "error" in parsed || save.isPending}
          >
            {save.isPending && save.variables && "add" in save.variables
              ? "Adding…"
              : "Add repository"}
          </button>
        </div>
        {parsed && "error" in parsed && (
          <p className="form-error" role="alert">
            {parsed.error}
          </p>
        )}
        {refusal("add")}
        <p className="text-small text-muted">
          Nakara checks that the agent token can push to it. A new repository
          widens what agents reach, so it waits for your approval.
        </p>
      </form>
    </section>
  );
}

/** Why a save was refused: the server's reasons, without their `repositories:` prefix. */
function Refusal({ error }: { error: Error }) {
  const problems = error instanceof ApiError ? error.problems : [];
  return (
    <div role="alert" className="grid gap-xs">
      {problems.length ? (
        problems.map((problem, index) => (
          <p key={problemKey(problem, index)} className="form-error">
            {problem.message.replace(/^repositories: /, "")}
          </p>
        ))
      ) : (
        <p className="form-error">{error.message}</p>
      )}
    </div>
  );
}
