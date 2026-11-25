import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { NotFound, Pending, RouteError } from "./app/fallbacks";
import { routeTree } from "./routeTree.gen";
import { basePath } from "./app/runtime";
import { ApiError } from "./lib/api";
import "./style.css";

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // Something missing stays missing; only other failures are worth retrying.
      retry: (failures, error) =>
        failures < 3 &&
        !(error instanceof ApiError && error.code === "not_found"),
    },
  },
});
const router = createRouter({
  routeTree,
  basepath: basePath || "/",
  context: { queryClient: client },
  // Load a page's data while the pointer rests on its link; the query cache decides freshness.
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  defaultPendingComponent: Pending,
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: NotFound,
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    /** Breadcrumb label of the page. */
    title?: string;
    /** A full-page route, shown without the shell. */
    bare?: boolean;
  }
}
// A tab open across a deploy asks for page chunks the new build removed; reload to get the new ones.
addEventListener("vite:preloadError", () => location.reload());
const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
