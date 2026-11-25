import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Outlet,
  useMatches,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { Shell } from "../app/shell";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  // ?new=1 opens the New work modal on any page, including server-rendered ones.
  validateSearch: (search: Record<string, unknown>): { new?: 1 } =>
    search.new === 1 || search.new === "1" ? { new: 1 } : {},
  component: Root,
});

/** Full-page routes such as the New factory wizard have no shell. */
function Root() {
  const bare = useMatches({
    select: (matches) => matches.some((match) => match.staticData.bare),
  });
  const title = useMatches({
    select: (matches) => matches.at(-1)?.staticData.title,
  });
  // The shell titles its own pages from the breadcrumb.
  useEffect(() => {
    if (bare) document.title = `${title} · Nakara`;
  }, [bare, title]);
  if (bare) return <Outlet />;
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
