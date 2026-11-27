import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, reloadDefinition, saveAutomation } from "../../lib/api";
import { plural } from "../../lib/format";
import { useToast } from "../../app/toast";

/** What a switch needs of an automation; the Automations page and Settings both have it. */
export interface Switchable {
  name: string;
  displayName: string;
  enabled: boolean;
  /** The automation.md revision the page loaded; null when not defined in a file. */
  revision: string | null;
}

/**
 * The automation's enabled switch, saved through its edit endpoint with the
 * file revision the page loaded. Both pages show the new state after the save:
 * it refetches the automations and the factory settings.
 */
export function useAutomationToggle(
  slug: string,
  {
    onSaved,
    onReload,
  }: {
    /** After a save, with the automation as switched and the new revision. */
    onSaved?: (automation: Switchable, revision: string) => void;
    /** A conflict's Reload; by default the definition is reloaded and refetched. */
    onReload?: () => void;
  } = {},
) {
  const client = useQueryClient();
  const toast = useToast();
  const refetch = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["automations", slug] }),
      client.invalidateQueries({ queryKey: ["factories", slug] }),
    ]);
  const reload = useMutation({
    mutationFn: () => reloadDefinition(slug),
    onSuccess: refetch,
  });
  return useMutation({
    mutationFn: ({
      automation,
      enabled,
    }: {
      automation: Switchable;
      enabled: boolean;
    }) =>
      saveAutomation(slug, automation.name, {
        enabled,
        revision: automation.revision ?? "",
      }),
    onSuccess: async (result, { automation, enabled }) => {
      onSaved?.(automation, result.revision);
      await refetch();
      toast(
        result.ok
          ? {
              title: `${automation.displayName} ${enabled ? "enabled" : "disabled"}`,
              tone: "ok",
            }
          : {
              title: `Saved, but the reload failed: ${plural(result.errors.length, "error")}`,
              description: "The last valid definition is still running.",
              tone: "bad",
            },
      );
    },
    onError: (error) =>
      toast({
        title: "The switch was not saved",
        description: error.message,
        tone: "bad",
        // A file changed on disk: load it as it is now, then switch again.
        ...(error instanceof ApiError &&
          error.code === "conflict" && {
            action: {
              label: "Reload",
              onClick: () => (onReload ? onReload() : reload.mutate()),
            },
          }),
      }),
  });
}

/** The switch the Automations table and the Settings intake rows show. */
export function AutomationSwitch({
  automation,
  toggle,
  label = `${automation.displayName} enabled`,
}: {
  automation: Switchable;
  toggle: ReturnType<typeof useAutomationToggle>;
  label?: string;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-checked={automation.enabled}
      aria-label={label}
      checked={automation.enabled}
      disabled={!automation.revision || toggle.isPending}
      title={automation.revision ? undefined : "Not defined in a file"}
      className="automation-switch"
      onClick={(event) => event.stopPropagation()}
      onChange={(event) =>
        toggle.mutate({ automation, enabled: event.target.checked })
      }
    />
  );
}
