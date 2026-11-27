import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "../../app/toast";
import { factorySettingsQuery, saveLimits } from "../../lib/api";

type GateCheck = "review" | "verification";

const GATE_SWITCHES: {
  check: GateCheck;
  key: "gateReview" | "gateVerification";
  label: string;
}[] = [
  { check: "review", key: "gateReview", label: "Review accepted" },
  {
    check: "verification",
    key: "gateVerification",
    label: "Verification passed",
  },
];

/**
 * The Handoff Gate: CI passing is always on and cannot be switched off; a
 * factory can add an accepted Review and a passed Verification.
 */
export function HandoffGateRow({
  slug,
  checks,
}: {
  slug: string;
  /** The checks the factory adds; new Work Items copy them. */
  checks: readonly GateCheck[];
}) {
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (edit: { check: GateCheck; on: boolean }) =>
      saveLimits(slug, {
        // biome-ignore lint/style/noNonNullAssertion: Every check has a switch.
        [GATE_SWITCHES.find((s) => s.check === edit.check)!.key]: edit.on,
      }),
    onSuccess: (limits, edit) => {
      // The saved checks show at once, not the stale ones until the refetch.
      client.setQueryData(
        factorySettingsQuery(slug).queryKey,
        (current) => current && { ...current, limits },
      );
      void client.invalidateQueries({ queryKey: ["factories", slug] });
      const label = GATE_SWITCHES.find((s) => s.check === edit.check)?.label;
      toast({
        title: "Handoff Gate saved",
        description: `${label} is ${edit.on ? "now required" : "no longer required"} for new Work Items.`,
        tone: "ok",
      });
    },
  });
  // A switch follows the click until the saved checks arrive.
  const isOn = (check: GateCheck) =>
    save.isPending && save.variables.check === check
      ? save.variables.on
      : checks.includes(check);
  return (
    <div className="box-row grid gap-sm">
      <span id="handoff-gate-label" className="field-label">
        Handoff Gate
      </span>
      <fieldset
        className="grid gap-sm"
        aria-labelledby="handoff-gate-label"
        disabled={save.isPending}
      >
        <label className="switch-field">
          <span>
            CI passes <span className="text-muted">(always on)</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="automation-switch"
            aria-checked
            checked
            disabled
            readOnly
          />
        </label>
        {GATE_SWITCHES.map((s) => (
          <label key={s.check} className="switch-field">
            <span>{s.label}</span>
            <input
              type="checkbox"
              role="switch"
              className="automation-switch"
              aria-checked={isOn(s.check)}
              checked={isOn(s.check)}
              onChange={(e) =>
                save.mutate({ check: s.check, on: e.target.checked })
              }
            />
          </label>
        ))}
      </fieldset>
      <p className="text-muted">
        The work is always pushed and CI always passes. A factory can add
        checks; it cannot remove those.
      </p>
      {save.error && (
        <p className="form-error" role="alert">
          {save.error.message}
        </p>
      )}
    </div>
  );
}
