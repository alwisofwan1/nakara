import * as Dialog from "@radix-ui/react-dialog";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ApiError,
  deleteFactory,
  factorySettingsQuery,
  loadPage,
  moveDefinition,
  renameFactory,
} from "../lib/api";
import {
  plural,
  problemKey,
  problemLocation,
  relativeTime,
} from "../lib/format";
import { Icon } from "../ui/icons";
import { useToast } from "../app/toast";
import {
  AVATAR_COLORS,
  DEFAULT_FOLDER,
  FOLDER,
} from "../features/wizard/wizard-state";

export const Route = createFileRoute("/f/$slug/settings")({
  loader: ({ context, params }) =>
    loadPage(context.queryClient, factorySettingsQuery(params.slug)),
  component: SettingsPage,
  staticData: { title: "Settings" },
});

type Settings = Awaited<
  ReturnType<NonNullable<ReturnType<typeof factorySettingsQuery>["queryFn"]>>
>;

function SettingsPage() {
  const { slug } = Route.useParams();
  const { data } = useSuspenseQuery(factorySettingsQuery(slug));
  return (
    <section className="grid gap-xl">
      <div className="grid gap-xs">
        <h1 className="text-heading font-semibold">Settings</h1>
        <p className="text-small text-muted">
          The factory's name, avatar and definition. Its slug,{" "}
          <code>{slug}</code>, and its pages at <code>/f/{slug}</code> never
          change.
        </p>
      </div>
      <General settings={data} />
      <Definition settings={data} />
      <DeleteFactory settings={data} />
    </section>
  );
}

/** Rename: the display name and avatar. */
function General({ settings }: { settings: Settings }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(settings.name);
  const [color, setColor] = useState(settings.avatarColor);
  // Another tab's rename arrives through /api/events.
  useEffect(() => {
    setName(settings.name);
    setColor(settings.avatarColor);
  }, [settings.name, settings.avatarColor]);
  const changed =
    name.trim() !== settings.name || color !== settings.avatarColor;
  const save = useMutation({
    mutationFn: () =>
      renameFactory(settings.slug, { name: name.trim(), avatarColor: color }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["factories"] });
      toast({
        title: "Settings saved",
        description: `The factory is now ${name.trim()}; its URLs stay the same.`,
        tone: "ok",
      });
    },
  });
  return (
    <form
      className="box"
      aria-labelledby="settings-general"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h2 id="settings-general" className="box-row font-semibold">
        General
      </h2>
      <div className="box-row grid gap-lg">
        <div className="flex items-start gap-md">
          <span
            className="wizard-avatar"
            style={{ backgroundColor: color }}
            aria-hidden="true"
          >
            {name.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <label className="field flex-1">
            <span className="field-label">Display name</span>
            <input
              className="input"
              value={name}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                save.reset();
              }}
            />
            <span className="text-small text-muted">
              Slug <code>{settings.slug}</code> · foreman{" "}
              <code>@{settings.foremanHandle}</code>
              {settings.label && (
                <>
                  {" "}
                  · GitHub label <code>{settings.label}</code> (set in
                  factory.yaml)
                </>
              )}
            </span>
          </label>
        </div>
        <fieldset className="grid gap-sm">
          <legend className="field-label mb-sm">Avatar color</legend>
          <div className="flex flex-wrap gap-md">
            {AVATAR_COLORS.map((c) => (
              <label
                key={c}
                className="wizard-swatch"
                style={{ backgroundColor: c }}
              >
                <input
                  type="radio"
                  name="avatar-color"
                  aria-label={c}
                  value={c}
                  checked={color === c}
                  onChange={() => {
                    setColor(c);
                    save.reset();
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
        {save.error && (
          <p className="form-error" role="alert">
            {save.error.message}
          </p>
        )}
        <div className="flex justify-end gap-sm">
          <button
            type="button"
            className="ghost"
            disabled={!changed || save.isPending}
            onClick={() => {
              setName(settings.name);
              setColor(settings.avatarColor);
              save.reset();
            }}
          >
            Discard
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!changed || !name.trim() || save.isPending}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Where the definition lives, its history, and Move to a repository folder. */
function Definition({ settings }: { settings: Settings }) {
  const { definition } = settings;
  const managed = definition.mode === "managed";
  return (
    <section className="box" aria-labelledby="settings-definition">
      <h2 id="settings-definition" className="box-row font-semibold">
        Definition
      </h2>
      <div className="box-row grid gap-xs">
        <p className="flex items-center gap-sm font-semibold">
          <Icon name="folder" className="icon" />
          {managed ? "Nakara-managed" : "A repository folder"}
        </p>
        <p className="break-all text-muted">{definition.dir}</p>
        <p className="text-muted">
          {managed
            ? "A local git repository: every edit on the web is a commit, so its history exists without GitHub."
            : "Git-tracked with your code. Edits on the web write the files; you commit and push them."}
        </p>
      </div>
      {managed && (
        <>
          <div className="box-row grid gap-sm">
            <h3 className="font-semibold">History</h3>
            {definition.history.length === 0 ? (
              <p className="text-muted">
                No commits yet. The first edit on the web starts the history.
              </p>
            ) : (
              <ol aria-label="Definition history" className="grid gap-xs">
                {definition.history.map((commit) => (
                  <li
                    key={commit.sha}
                    className="flex flex-wrap items-center gap-sm"
                  >
                    <Icon name="commit" className="icon text-muted" />
                    <code className="text-muted">{commit.sha.slice(0, 7)}</code>
                    <span className="flex-1">{commit.message}</span>
                    <time
                      className="text-muted"
                      dateTime={commit.at}
                      title={commit.at}
                    >
                      {relativeTime(commit.at)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <MoveDefinition settings={settings} />
        </>
      )}
    </section>
  );
}

function MoveDefinition({ settings }: { settings: Settings }) {
  const client = useQueryClient();
  const toast = useToast();
  const { repositories } = settings.definition;
  const [repo, setRepo] = useState(repositories[0] ?? "");
  const [folder, setFolder] = useState(DEFAULT_FOLDER);
  const [open, setOpen] = useState(false);
  const folderOk = FOLDER.test(folder);
  const move = useMutation({
    mutationFn: () => moveDefinition(settings.slug, { repo, folder }),
    onSuccess: (result) => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["factories"] });
      void client.invalidateQueries({ queryKey: ["definition"] });
      toast({
        title: "Definition moved",
        description: result.archive
          ? `The factory now runs the definition in ${result.dir}. The managed folder is archived in ${result.archive}.`
          : `The factory now runs the definition in ${result.dir}. The managed folder could not be archived and stays in ${settings.definition.dir}.`,
        tone: "ok",
      });
    },
  });
  const problems = move.error instanceof ApiError ? move.error.problems : [];
  // The section and the confirmation say the same about the archive.
  const archived = `The Nakara-managed folder, with its git history, is kept as an archive in ${settings.definition.archiveDir}.`;
  return (
    <div className="box-row grid gap-md">
      <div className="grid gap-xs">
        <h3 className="font-semibold">Move to a repository folder</h3>
        <p className="text-muted">
          Nakara writes the definition into its own clone of the repository and
          runs it from there; you commit and push the folder. {archived}
        </p>
      </div>
      {repositories.length === 0 ? (
        <p className="text-muted">
          The definition lists no repositories, or none is loaded.
        </p>
      ) : (
        <div className="field-row">
          <label className="field">
            <span className="field-label">Repository</span>
            <select
              className="input"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            >
              {repositories.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Folder</span>
            <input
              className="input"
              value={folder}
              autoComplete="off"
              aria-invalid={!folderOk}
              onChange={(event) => setFolder(event.target.value)}
            />
            {!folderOk && (
              <span role="alert" className="text-small text-bad">
                A relative path such as factory or ops/factory.
              </span>
            )}
          </label>
        </div>
      )}
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) move.reset();
        }}
      >
        <div className="flex justify-end">
          <Dialog.Trigger
            type="button"
            className="ghost"
            disabled={!repo || !folderOk}
          >
            Move definition
          </Dialog.Trigger>
        </div>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="modal">
            <div className="modal-head">
              <Dialog.Title className="text-title font-bold">
                Move the definition to {repo}?
              </Dialog.Title>
              <Dialog.Close className="icon-button" aria-label="Close">
                ✕
              </Dialog.Close>
            </div>
            <div className="modal-body">
              <Dialog.Description className="text-small">
                The files are written to {folder}/ in Nakara's clone of {repo},
                which must not have that folder yet. The factory then runs them
                from there. {archived}
              </Dialog.Description>
              {move.error && (
                <div className="form-error" role="alert">
                  <p>{move.error.message}</p>
                  {problems.length > 0 && (
                    <ul className="mt-xs grid gap-xs">
                      {problems.map((problem, index) => (
                        <li key={problemKey(problem, index)}>
                          <code>{problemLocation(problem)}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="modal-foot justify-end">
              <Dialog.Close type="button" className="ghost">
                Cancel
              </Dialog.Close>
              <button
                type="button"
                className="primary"
                disabled={move.isPending}
                onClick={() => move.mutate()}
              >
                {move.isPending ? "Moving…" : "Move definition"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/** Delete, after confirmation; the server refuses it while items are active. */
function DeleteFactory({ settings }: { settings: Settings }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteFactory(settings.slug),
    onSuccess: async (result) => {
      setOpen(false);
      await navigate({ to: "/" });
      client.removeQueries({ queryKey: ["factories", settings.slug] });
      void client.invalidateQueries({ queryKey: ["factories"] });
      toast({
        title: "Factory deleted",
        description: `${settings.name} and its closed work were removed. The database snapshot from before is ${result.snapshot}.`,
        tone: "ok",
      });
    },
  });
  const managed = settings.definition.mode === "managed";
  return (
    <section className="danger-zone" aria-labelledby="danger-zone">
      <h2 id="danger-zone" className="font-semibold text-bad">
        Danger zone
      </h2>
      <div className="flex flex-wrap items-center gap-md">
        <p className="flex-1 text-small text-muted">
          {settings.isDefault
            ? "This is the default factory: Telegram and work without a factory go to it, so it cannot be deleted."
            : settings.activeItems > 0
              ? `${plural(settings.activeItems, "active work item")}. Complete or cancel ${settings.activeItems === 1 ? "it" : "them"} before deleting the factory.`
              : "Delete the factory with its closed work items and their runs."}
        </p>
        <Dialog.Root
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) remove.reset();
          }}
        >
          <Dialog.Trigger
            type="button"
            className="danger"
            disabled={settings.isDefault}
          >
            Delete factory
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="modal-overlay" />
            <Dialog.Content className="modal">
              <div className="modal-head">
                <Dialog.Title className="text-title font-bold">
                  Delete {settings.name}?
                </Dialog.Title>
                <Dialog.Close className="icon-button" aria-label="Close">
                  ✕
                </Dialog.Close>
              </div>
              <div className="modal-body">
                <Dialog.Description className="text-small">
                  Its intake stops, and its closed work items with their runs
                  and messages are deleted.{" "}
                  {managed
                    ? `Its Nakara-managed definition and history in ${settings.definition.dir} are deleted too.`
                    : `Its definition in ${settings.definition.dir} is left as it is.`}{" "}
                  First, a snapshot of the database (reason pre-delete-
                  {settings.slug}) is saved in {settings.backupDir}. Restoring
                  it (README, Backup and restore) is the only way to undo the
                  delete.
                </Dialog.Description>
                {remove.error && (
                  <p className="form-error" role="alert">
                    {remove.error.message}
                  </p>
                )}
              </div>
              <div className="modal-foot justify-end">
                <Dialog.Close type="button" className="ghost">
                  Keep factory
                </Dialog.Close>
                <button
                  type="button"
                  className="danger-solid"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? "Deleting…" : "Delete factory"}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </section>
  );
}
