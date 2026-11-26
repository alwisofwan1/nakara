import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, deleteAutomation } from "../../lib/api";
import { problemKey, problemLocation } from "../../lib/format";
import { useToast } from "../../app/toast";

/**
 * The drawer footer's Delete, confirmed inline. The work items the automation
 * created stay; its triggers stop with the reload.
 */
export function DeleteAutomation({
  slug,
  name,
  revision,
  onDeleted,
  onConflict,
}: {
  slug: string;
  name: string;
  revision: string | null;
  onDeleted: () => void;
  onConflict: () => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteAutomation(slug, name, revision ?? ""),
    onSuccess: async () => {
      onDeleted();
      await client.invalidateQueries({ queryKey: ["automations"] });
      toast({
        title: "Automation deleted",
        description: `automations/${name} was removed; its work items stay.`,
        tone: "ok",
      });
    },
  });
  const problems =
    remove.error instanceof ApiError ? remove.error.problems : [];
  const conflict =
    remove.error instanceof ApiError && remove.error.code === "conflict";
  return (
    <footer className="grid gap-sm border-t border-line pt-lg">
      {remove.error && (
        <div role="alert" className="banner bad">
          <p className="font-semibold">
            {conflict
              ? `automations/${name}/automation.md changed on disk since this pane was loaded. Reload, then delete again.`
              : remove.error.message}
          </p>
          {conflict && (
            <button
              type="button"
              className="ghost justify-self-start"
              onClick={() => {
                remove.reset();
                setConfirming(false);
                onConflict();
              }}
            >
              Reload
            </button>
          )}
          {problems.length > 0 && (
            <ul className="grid gap-xs">
              {problems.map((problem, index) => (
                <li key={problemKey(problem, index)} className="problem">
                  <code>{problemLocation(problem)}</code> {problem.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {confirming ? (
        <div className="flex flex-wrap items-center justify-end gap-sm">
          <span className="mr-auto font-semibold">Delete {name}?</span>
          <button
            type="button"
            className="danger-solid"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={remove.isPending}
            onClick={() => {
              setConfirming(false);
              remove.reset();
            }}
          >
            Keep
          </button>
        </div>
      ) : (
        <div className="flex justify-end">
          <button
            type="button"
            className="danger"
            disabled={!revision}
            title={revision ? undefined : "Not defined in a file"}
            onClick={() => setConfirming(true)}
          >
            Delete
          </button>
        </div>
      )}
    </footer>
  );
}
