import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { stopRun } from "../../lib/api";
import { Icon } from "../../ui/icons";

/**
 * Stop run, with a confirmation, for the Run page and the work item's building
 * card. The run shows as cancelled once its process has exited, which arrives
 * through /api/events.
 */
export function StopRunButton({
  run,
}: {
  run: { id: number; status: string; docker: boolean };
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const stop = useMutation({
    mutationFn: () => stopRun(run.id),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const running = run.status === "running";
  // Between the accepted stop and the run's exit, the button says so.
  const stopping = running && stop.isSuccess;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) stop.reset();
      }}
    >
      <Dialog.Trigger
        type="button"
        className="danger"
        disabled={!running || stopping}
        title={running ? undefined : "Only a running run can be stopped"}
      >
        <Icon name="square" className="h-icon w-icon" />
        {stopping ? "Stopping…" : "Stop run"}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <div className="modal-head">
            <Dialog.Title className="text-title font-bold">
              Stop run #{run.id}?
            </Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close">
              ✕
            </Dialog.Close>
          </div>
          <div className="modal-body">
            <Dialog.Description className="text-small">
              {run.docker
                ? "Its container is removed"
                : "Its process is terminated"}{" "}
              and the run is marked cancelled. The work item is not cancelled:
              the foreman is told that you stopped this run and decides what
              happens next.
            </Dialog.Description>
            {stop.error && (
              <p className="form-error" role="alert">
                {stop.error.message}
              </p>
            )}
          </div>
          <div className="modal-foot justify-end">
            <Dialog.Close type="button" className="ghost">
              Keep running
            </Dialog.Close>
            <button
              type="button"
              className="danger-solid"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              {stop.isPending ? "Stopping…" : "Stop run"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
