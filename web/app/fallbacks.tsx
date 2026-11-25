import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { EmptyState } from "../ui/empty-state";
import { usePageCrumbs } from "./shell";

export function NotFound() {
  usePageCrumbs([{ label: "Page not found" }]);
  return <p>Page not found.</p>;
}

/** Shown while a page's data takes longer than the router's pendingMs. */
export function Pending() {
  return <p role="status">Loading…</p>;
}

/** A page that failed to load or render; the shell and other pages keep working. */
export function RouteError({ error }: ErrorComponentProps) {
  usePageCrumbs([{ label: "Error" }]);
  const router = useRouter();
  return (
    <EmptyState
      icon="circle-x"
      title="This page failed to load"
      action={
        // Reruns the page's loader, which also resets the error boundary.
        <button type="button" onClick={() => void router.invalidate()}>
          Try again
        </button>
      }
    >
      {(error instanceof Error && error.message) || "Unknown error"}
    </EmptyState>
  );
}
