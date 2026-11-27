import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment } from "react";

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
 * Whether Verification passed can never be met: it is on and the definition
 * has no VERIFY agent to run. Unknown (no definition loaded) does not warn.
 */
export const verificationUnreachable = (
  on: boolean,
  verifyAgent: boolean | null,
): boolean => on && verifyAgent === false;

/**
 * Whether one review that asks for changes leaves the item waiting for the
 * Operator: Review accepted is on and the review limit allows a single review.
 */
export const reviewWaitsOnOperator = (
  on: boolean,
  maxReviews: number,
): boolean => on && maxReviews <= 1;

/**
 * The Handoff Gate: CI passing is always on and cannot be switched off; a
 * factory can add an accepted Review and a passed Verification.
 */
export function HandoffGateRow({
  slug,
  checks,
  maxReviews,
  verifyAgent,
}: {
  slug: string;
  /** The checks the factory adds; new Work Items copy them. */
  checks: readonly GateCheck[];
  /** The factory's review limit that new Work Items copy. */
  maxReviews: number;
  /** Whether the applied definition has a VERIFY agent; null when none is loaded. */
  verifyAgent: boolean | null;
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
          <Fragment key={s.check}>
            <label className="switch-field">
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
            {/* Saving stays allowed: the definition and limits can change after it. */}
            {s.check === "review" &&
              reviewWaitsOnOperator(isOn("review"), maxReviews) && (
                <p role="note" className="text-muted">
                  With a review limit of 1, a review that asks for changes
                  leaves the Work Item waiting for you: review cannot run again
                  to accept the fix. Raise the review limit to let the Foreman
                  review again.
                </p>
              )}
            {s.check === "verification" &&
              verificationUnreachable(isOn("verification"), verifyAgent) && (
                <p role="note" className="banner attention">
                  This factory's definition has no verify agent, so no
                  Verification can pass and new Work Items will wait for you at
                  handoff. Add a VERIFY agent to the definition, or turn this
                  check off.
                </p>
              )}
          </Fragment>
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
