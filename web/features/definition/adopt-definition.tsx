import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, adoptDefinition } from "../../lib/api";
import { problemKey, problemLocation } from "../../lib/format";
import { useToast } from "../../app/toast";

/**
 * "Let Nakara manage it" for a Repository Definition, with a confirmation:
 * the files are copied into a Nakara-managed folder and run from there; the
 * repository folder is left as it is and no longer read.
 */
export function AdoptDefinition({
  slug,
  dir,
  className = "ghost",
}: {
  slug: string;
  /** The repository folder the definition is read from now. */
  dir: string;
  className?: string;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const adopt = useMutation({
    mutationFn: () => adoptDefinition(slug),
    onSuccess: (result) => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["factories"] });
      void client.invalidateQueries({ queryKey: ["definition"] });
      toast({
        title: "Nakara manages the definition",
        description: `The factory now runs the definition in ${result.dir}. ${result.note}`,
        tone: "ok",
      });
    },
  });
  const problems = adopt.error instanceof ApiError ? adopt.error.problems : [];
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) adopt.reset();
      }}
    >
      <Dialog.Trigger type="button" className={className}>
        Let Nakara manage it
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <div className="modal-head">
            <Dialog.Title className="text-title font-bold">
              Let Nakara manage the definition?
            </Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close">
              ✕
            </Dialog.Close>
          </div>
          <div className="modal-body">
            <Dialog.Description className="text-small">
              Nakara copies the definition's files from {dir} into a folder of
              its own, where every edit on the web is a commit, and the factory
              runs them from there. Later edits in the repository folder are no
              longer read. Nakara leaves that folder as it is; you can delete it
              by hand.
            </Dialog.Description>
            {adopt.error && (
              <div className="form-error" role="alert">
                <p>{adopt.error.message}</p>
                {problems.length > 0 && (
                  <ul className="mt-xs grid gap-xs">
                    {problems.map((problem, index) => (
                      <li key={problemKey(problem, index)}>
                        <code>{problemLocation(problem)}</code>{" "}
                        {problem.message}
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
              disabled={adopt.isPending}
              onClick={() => adopt.mutate()}
            >
              {adopt.isPending ? "Copying…" : "Let Nakara manage it"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
