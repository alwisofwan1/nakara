import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { appendLog, emptyLog, type LogState } from "./log";
import { serverUrl } from "../../app/runtime";

/**
 * Tail a run's transcript over `/api/runs/:id/log`. EventSource reconnects on
 * its own with Last-Event-ID, so the server resumes from the last byte offset.
 */
export function useRunLog(runId: number): LogState {
  const client = useQueryClient();
  const [log, setLog] = useState(emptyLog);
  useEffect(() => {
    setLog(emptyLog);
    const source = new EventSource(serverUrl(`/api/runs/${runId}/log`));
    source.onmessage = (event) => {
      let chunk: unknown;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof chunk === "string") setLog((state) => appendLog(state, chunk));
    };
    source.addEventListener("end", () => {
      // Closing stops the automatic reconnect; the run is over.
      source.close();
      setLog((state) => appendLog(state, "", true));
      void client.invalidateQueries({ queryKey: ["runs", runId] });
      void client.invalidateQueries({ queryKey: ["run-diff", runId] });
    });
    return () => source.close();
  }, [runId, client]);
  return log;
}
