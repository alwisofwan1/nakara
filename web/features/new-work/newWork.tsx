import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { createWork, type NewWork, newWorkQuery } from "../../lib/api";
import { type Prefill, prefillValues } from "./prefill";

type Options = Awaited<
  ReturnType<NonNullable<ReturnType<typeof newWorkQuery>["queryFn"]>>
>;

/** New work in the factory with this slug. */
export function NewWorkDialog({
  slug,
  open,
  onOpenChange,
  prefill,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Starting values, for Duplicate as new work. */
  prefill?: Prefill;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal" aria-describedby={undefined}>
          <div className="modal-head">
            <Dialog.Title className="text-title font-bold">
              New work
            </Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close">
              ✕
            </Dialog.Close>
          </div>
          <NewWorkBody slug={slug} prefill={prefill} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NewWorkBody({ slug, prefill }: { slug: string; prefill?: Prefill }) {
  const { data, error } = useQuery(newWorkQuery(slug));
  if (data) return <NewWorkForm slug={slug} options={data} prefill={prefill} />;
  return (
    <p className="modal-body" role="status">
      {error ? error.message : "Loading…"}
    </p>
  );
}

function NewWorkForm({
  slug,
  options,
  prefill,
}: {
  slug: string;
  options: Options;
  prefill?: Prefill;
}) {
  const listId = useId();
  const [initial] = useState(() =>
    prefill
      ? prefillValues(prefill, options)
      : {
          title: "",
          request: "",
          repo: "",
          automation: options.defaults.automation ?? "",
        },
  );
  const [title, setTitle] = useState(initial.title);
  const [request, setRequest] = useState(initial.request);
  const [issueUrl, setIssueUrl] = useState("");
  const [repo, setRepo] = useState(initial.repo);
  const [automation, setAutomation] = useState(initial.automation);
  const [budget, setBudget] = useState(options.defaults.budgetUsd.toFixed(2));
  const [requester, setRequester] = useState(options.defaults.requester);
  // Only a `when_asked` factory lets the item choose; `always` asks for it anyway.
  const [spec, setSpec] = useState(false);
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (json: NewWork) => createWork(slug, json),
    // Dropping the search params also closes this modal.
    onSuccess: ({ id }) =>
      navigate({
        to: "/items/$itemId",
        params: { itemId: String(id) },
        search: {},
      }),
  });
  const importing = issueUrl.trim() !== "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending || create.isSuccess) return;
    create.mutate({
      title: importing ? "" : title,
      request: importing ? "" : request,
      issueUrl,
      repo: repo || null,
      automation: automation || null,
      budgetUsd: Number(budget),
      requester,
      spec: options.specRule === "when_asked" && spec,
    });
  };
  const shortcut = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={shortcut}
      // A refusal belongs to the submitted values; editing clears it.
      onChange={() => create.error && create.reset()}
    >
      <div className="modal-body">
        {!options.ready && (
          <p className="form-error" role="alert">
            No valid factory definition is loaded, so work can't be created.
          </p>
        )}
        <label className="field">
          <span className="field-label">Title</span>
          <input
            className="input"
            value={importing ? "" : title}
            onChange={(e) => setTitle(e.target.value)}
            required={!importing}
            disabled={importing}
            maxLength={200}
            placeholder={
              importing
                ? "Imported from the issue"
                : "Add retry button to failed work items"
            }
          />
        </label>
        <label className="field">
          <span className="field-label">
            Request
            <span className="field-hint">
              Markdown. What should change and why.
            </span>
          </span>
          <textarea
            className="input"
            rows={6}
            value={importing ? "" : request}
            onChange={(e) => setRequest(e.target.value)}
            required={!importing}
            disabled={importing}
            placeholder={
              importing
                ? "Imported from the issue"
                : "What you want, why, and anything the factory should know. Links, logs and acceptance criteria help."
            }
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span className="field-label">Repository</span>
            <select
              className="input"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
            >
              <option value="">All factory repositories</option>
              {options.repositories.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Automation</span>
            <select
              className="input"
              value={automation}
              onChange={(e) => setAutomation(e.target.value)}
            >
              <option value="">None (the foreman decides)</option>
              {options.automations.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span className="field-label">
              Budget<span className="field-hint">USD</span>
            </span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              required
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Requester</span>
            <input
              className="input"
              list={`${listId}-requesters`}
              required
              maxLength={100}
              value={requester}
              onChange={(e) => setRequester(e.target.value)}
            />
            <datalist id={`${listId}-requesters`}>
              {options.requesters.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
        </div>
        {options.specRule !== "never" && (
          <label className="switch-field">
            <span className="grid">
              <span className="field-label">Write a Spec first</span>
              <span className="field-hint">
                {options.specRule === "always"
                  ? `#${slug} always asks for one.`
                  : "The Spec is written into the Pull Request, and you approve it before implement starts."}
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="automation-switch"
              aria-checked={options.specRule === "always" || spec}
              checked={options.specRule === "always" || spec}
              disabled={options.specRule === "always"}
              onChange={(e) => setSpec(e.target.checked)}
            />
          </label>
        )}
        <label className="import-issue">
          <span className="field-hint">
            Or paste a GitHub issue URL to import it
            {options.issueLabel
              ? ` (labeling it ${options.issueLabel} does the same)`
              : ""}
            .
          </span>
          <input
            className="input"
            type="url"
            value={issueUrl}
            onChange={(e) => setIssueUrl(e.target.value)}
            placeholder="https://github.com/owner/repo/issues/1"
          />
        </label>
        {create.error && (
          <p className="form-error" role="alert">
            {create.error.message}
          </p>
        )}
      </div>
      <div className="modal-foot">
        <span className="text-small text-muted">Ctrl+Enter to create</span>
        <div className="flex gap-sm">
          <Dialog.Close type="button" className="ghost">
            Cancel
          </Dialog.Close>
          <button
            type="submit"
            className="primary"
            disabled={!options.ready || create.isPending || create.isSuccess}
          >
            {create.isPending ? "Creating…" : "Create work item"}
          </button>
        </div>
      </div>
    </form>
  );
}
