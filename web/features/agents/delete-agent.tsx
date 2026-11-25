import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError, deleteAgent } from "../../lib/api";
import { problemKey, problemLocation } from "../../lib/format";
import { useToast } from "../../app/toast";

/**
 * The danger zone of an agent's Settings: Delete agent, with a confirmation.
 * The server refuses a delete that would break the definition, for example the
 * foreman or an agent an automation names, with the loader's message.
 */
export function DeleteAgent({
  slug,
  name,
  revision,
}: {
  slug: string;
  name: string;
  revision: string | null;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteAgent(slug, name, revision ?? ""),
    onSuccess: async () => {
      setOpen(false);
      await navigate({ to: "/f/$slug/agents", params: { slug } });
      client.removeQueries({ queryKey: ["agents", slug, name] });
      void client.invalidateQueries({ queryKey: ["agents"] });
      toast({
        title: "Agent deleted",
        description: `agents/${name} was removed from the definition.`,
        tone: "ok",
      });
    },
  });
  const problems =
    remove.error instanceof ApiError ? remove.error.problems : [];
  return (
    <section className="danger-zone" aria-labelledby="danger-zone">
      <h2 id="danger-zone" className="font-semibold text-bad">
        Danger zone
      </h2>
      <div className="flex flex-wrap items-center gap-md">
        <p className="flex-1 text-small text-muted">
          Delete agents/{name} with its agent.md and skills. The foreman can no
          longer dispatch it; past runs stay in the history.
        </p>
        <Dialog.Root
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) remove.reset();
          }}
        >
          <Dialog.Trigger type="button" className="danger" disabled={!revision}>
            Delete agent
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="modal-overlay" />
            <Dialog.Content className="modal">
              <div className="modal-head">
                <Dialog.Title className="text-title font-bold">
                  Delete {name}?
                </Dialog.Title>
                <Dialog.Close className="icon-button" aria-label="Close">
                  ✕
                </Dialog.Close>
              </div>
              <div className="modal-body">
                <Dialog.Description className="text-small">
                  agents/{name} is deleted from disk and the definition is
                  reloaded. This cannot be undone from Nakara; restore it from
                  git if the definition is tracked.
                </Dialog.Description>
                {remove.error && (
                  <div className="form-error" role="alert">
                    <p>{remove.error.message}</p>
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
                  Keep agent
                </Dialog.Close>
                <button
                  type="button"
                  className="danger-solid"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {remove.isPending ? "Deleting…" : "Delete agent"}
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </section>
  );
}
