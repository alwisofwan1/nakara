import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { invalidateChange, revalidateLive } from "./events";
import { serverUrl } from "./runtime";

/** Refetch live data as /api/events announces changes; the shell and the wizard subscribe. */
export function useChangeEvents() {
  const client = useQueryClient();
  const router = useRouter();
  useEffect(() => {
    const source = new EventSource(serverUrl("/api/events"));
    source.onopen = () => {
      revalidateLive(client);
      // A page that failed while the server was away loads again.
      void router.invalidate({ filter: (match) => match.status === "error" });
    };
    source.onmessage = (event) => invalidateChange(client, event.data);
    return () => source.close();
  }, [client, router]);
}
