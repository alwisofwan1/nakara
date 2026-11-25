import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  useMatches,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { statusQuery } from "../lib/api";
import { backupStale, plural, relativeTime } from "../lib/format";
import { FactoryAvatar, useFactories } from "./factory";
import { Icon } from "../ui/icons";
import { useChangeEvents } from "./live-events";
import { NewWorkDialog } from "../features/new-work/newWork";
import { defaultFactory } from "./runtime";
import { Toaster } from "./toast";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    title?: string;
  }
}
/** A breadcrumb step after the factory; `href` is a server path (the last step is the current page). */
export interface Crumb {
  label: string;
  href?: string;
}
/** A page's breadcrumb, and the factory it belongs to when its path has none. */
interface PageCrumbs {
  crumbs: Crumb[];
  factory?: string | undefined;
}
const CrumbsContext = createContext<(page: PageCrumbs | null) => void>(
  () => {},
);

/**
 * Set the header breadcrumb while the calling page is mounted. Item and run
 * pages have no factory in their path, so they name their item's factory.
 */
export function usePageCrumbs(crumbs: Crumb[], factory?: string) {
  const setCrumbs = useContext(CrumbsContext);
  const key = JSON.stringify({ crumbs, factory });
  useEffect(() => {
    setCrumbs(JSON.parse(key));
    return () => setCrumbs(null);
  }, [key, setCrumbs]);
}

function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { data, isError } = useQuery(statusQuery);
  const factories = useFactories();
  return (
    <>
      <Link className="brand" to="/" onClick={onNavigate}>
        <svg
          className="logo"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="m14 5 5 5-3 3-5-5 3-3ZM12 10 4 18l2 2 8-8M14 5l2-2 5 5-2 2" />
        </svg>
        Nakara
      </Link>
      <nav aria-label="Workspace">
        <Link
          className="nav-link"
          to="/inbox"
          activeOptions={{ includeSearch: false }}
          activeProps={{ "aria-current": "page" }}
          onClick={onNavigate}
        >
          Inbox
          {Boolean(data?.inbox) && <span className="badge">{data?.inbox}</span>}
        </Link>
        <Link
          className="nav-link"
          to="/runs"
          activeOptions={{ includeSearch: false }}
          activeProps={{ "aria-current": "page" }}
          onClick={onNavigate}
        >
          Runs
        </Link>
        <Link
          className="nav-link"
          to="/setup"
          activeProps={{ "aria-current": "page" }}
          onClick={onNavigate}
        >
          Setup
        </Link>
      </nav>
      <nav aria-label="Factories">
        <div className="nav-heading">
          <p>Factories</p>
          <Link
            className="icon-button"
            to="/factories/new"
            aria-label="New factory"
            title="New factory"
            onClick={onNavigate}
          >
            <Icon name="plus" className="h-icon w-icon" />
          </Link>
        </div>
        {factories.map(({ slug, name, avatarColor }) => {
          const problems = data?.factories.find((f) => f.slug === slug);
          return (
            // biome-ignore lint/a11y/useSemanticElements: A fieldset groups form controls; this groups one factory's page links.
            <div key={slug} className="contents" role="group" aria-label={name}>
              <div className="factory-name">
                <FactoryAvatar name={name} color={avatarColor} />
                <span className="flex-1">{name}</span>
                {problems && !problems.loaded && (
                  <span
                    className="flex text-bad"
                    title="No valid definition is loaded"
                  >
                    <Icon name="circle-x" className="h-icon w-icon" />
                    <span className="sr-only">
                      No valid definition is loaded
                    </span>
                  </span>
                )}
              </div>
              <div className="factory-pages">
                {(
                  [
                    ["/f/$slug/activity", "Activity"],
                    ["/f/$slug/blueprint", "Blueprint"],
                    ["/f/$slug/agents", "Agents"],
                    ["/f/$slug/automations", "Automations"],
                    ["/f/$slug/definition", "Definition"],
                    ["/f/$slug/settings", "Settings"],
                  ] as const
                ).map(([to, label]) => (
                  <Link
                    key={to}
                    className="nav-link"
                    to={to}
                    params={{ slug }}
                    activeProps={{ "aria-current": "page" }}
                    onClick={onNavigate}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <footer className="sidebar-footer">
        {data ? (
          <>
            <div>
              GitHub poll ·{" "}
              {data.github ? (
                <>
                  <time dateTime={data.github.at} title={data.github.at}>
                    {new Date(data.github.at).toLocaleTimeString()}
                  </time>
                  {data.github.error ? " · Failed" : ""}
                </>
              ) : (
                "Not yet polled"
              )}
            </div>
            <div>
              Telegram ·{" "}
              {data.telegram.configured ? "Configured" : "Not configured"}
            </div>
            <div>
              Slots · {data.slots.busy}/{data.slots.total} busy
            </div>
            <div>
              Backup ·{" "}
              {data.backup.at ? (
                <>
                  <time dateTime={data.backup.at} title={data.backup.at}>
                    {relativeTime(data.backup.at)}
                  </time>
                  {backupStale(data.backup) ? " · Stale" : ""}
                </>
              ) : (
                "None yet"
              )}
            </div>
          </>
        ) : (
          <p role="status">
            {isError ? "Status unavailable. Reconnecting…" : "Loading status…"}
          </p>
        )}
      </footer>
    </>
  );
}

/** Factory-wide problems that would otherwise leave pages silently empty. */
function Warnings() {
  const { data } = useQuery(statusQuery);
  const factories = useFactories();
  // One broken definition stops only its own factory; the others keep running.
  const broken = (data?.factories ?? []).filter((f) => !f.loaded);
  const others = factories.length > 1;
  return (
    <>
      {broken.map(({ slug, errors }) => (
        <p key={slug} className="shell-alert" role="alert">
          {others
            ? `${factories.find((f) => f.slug === slug)?.name ?? slug} has no valid definition loaded (${plural(errors, "error")}); the other factories keep running.`
            : "No valid factory definition is loaded."}{" "}
          See{" "}
          <Link to="/f/$slug/definition" params={{ slug }}>
            Definition
          </Link>
          .
        </p>
      ))}
      {data && backupStale(data.backup) && (
        <p className="shell-alert" role="alert">
          {data.backup.at
            ? `The last backup is from ${relativeTime(data.backup.at)}, older than twice the ${data.backup.intervalHours} h interval.`
            : "No backup of the database exists yet."}{" "}
          See the server log.
        </p>
      )}
      {data?.github?.error && (
        <p className="shell-alert" role="alert">
          GitHub polling: {data.github.error}
        </p>
      )}
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PageCrumbs | null>(null);
  const crumbs = page?.crumbs ?? null;
  const newWork = useSearch({ from: "__root__" }).new === 1;
  // Item and run pages have no factory in their path; they name their item's
  // factory, and other pages without one show the first factory.
  const slug = useParams({ strict: false }).slug ?? page?.factory;
  const factories = useFactories();
  const factory = factories.find((f) => f.slug === slug) ?? defaultFactory;
  const navigate = useNavigate();
  const setNewWork = (show: boolean) =>
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, new: show ? 1 : undefined }),
    });
  const title = useMatches({
    select: (matches) => matches.at(-1)?.staticData.title,
  });
  const trail = crumbs ?? [{ label: title ?? "Activity" }];
  const pageTitle = `${trail.at(-1)?.label} · ${factory.name} · Nakara`;
  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);
  useChangeEvents();
  useEffect(() => {
    const desktop = matchMedia("(min-width: 701px)");
    const close = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, []);
  return (
    <Toaster>
      <div className="shell">
        <aside className="sidebar desktop-sidebar" aria-label="Sidebar">
          <Navigation />
        </aside>
        <div className="workspace">
          <header className="page-header">
            <Dialog.Root open={open} onOpenChange={setOpen}>
              <Dialog.Trigger
                className="menu-button ghost"
                aria-label="Open navigation menu"
              >
                ☰
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="menu-overlay" />
                <Dialog.Content
                  className="sidebar mobile-sidebar"
                  aria-describedby={undefined}
                >
                  <Dialog.Title className="sr-only">Navigation</Dialog.Title>
                  <Dialog.Close className="ghost close-menu">
                    Close menu
                  </Dialog.Close>
                  <Navigation onNavigate={() => setOpen(false)} />
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <Link to="/f/$slug/activity" params={{ slug: factory.slug }}>
                {factory.name}
              </Link>
              {trail.map((crumb, index, all) => (
                <span
                  className="contents"
                  key={`${crumb.href ?? ""}:${crumb.label}`}
                >
                  <span aria-hidden="true">/</span>
                  {crumb.href && index < all.length - 1 ? (
                    <Link to={crumb.href}>{crumb.label}</Link>
                  ) : (
                    <span aria-current="page">{crumb.label}</span>
                  )}
                </span>
              ))}
            </nav>
            <button
              type="button"
              className="new-work"
              onClick={() => setNewWork(true)}
            >
              New work
            </button>
            <NewWorkDialog
              slug={factory.slug}
              open={newWork}
              onOpenChange={setNewWork}
            />
          </header>
          <main>
            <Warnings />
            <CrumbsContext.Provider value={setPage}>
              {children}
            </CrumbsContext.Provider>
          </main>
        </div>
      </div>
    </Toaster>
  );
}
