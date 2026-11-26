import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useToast } from "../../app/toast";
import { saveLimits } from "../../lib/api";

type SpecRule = NonNullable<Parameters<typeof saveLimits>[1]["specRule"]>;

const SPEC_RULE_OPTIONS: { rule: SpecRule; label: string }[] = [
  { rule: "always", label: "Always" },
  { rule: "when_asked", label: "When triage asks" },
  { rule: "never", label: "Never" },
];

/** Spec before code: Always, When triage asks (the Foreman decides) or Never. */
export function SpecRuleRow({
  slug,
  rule,
  specAgent,
}: {
  slug: string;
  rule: SpecRule;
  /** Whether the loaded definition has a SPEC agent; null when none is loaded. */
  specAgent: boolean | null;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: (specRule: SpecRule) => saveLimits(slug, { specRule }),
    onSuccess: (_, specRule) => {
      void client.invalidateQueries({ queryKey: ["factories", slug] });
      toast({
        title: "Spec rule saved",
        description: `Spec before code: ${SPEC_RULE_OPTIONS.find((o) => o.rule === specRule)?.label} for new Work Items.`,
        tone: "ok",
      });
    },
  });
  // The pressed option follows the click until the saved rule arrives.
  const shown = save.isPending ? save.variables : rule;
  return (
    <div className="box-row grid gap-xs">
      <div className="limit-row">
        <span id="spec-rule-label" className="field-label">
          Spec before code
        </span>
        <fieldset
          className="segmented"
          aria-labelledby="spec-rule-label"
          disabled={save.isPending}
        >
          {SPEC_RULE_OPTIONS.map((option) => (
            <button
              key={option.rule}
              type="button"
              className="segmented-option"
              aria-pressed={shown === option.rule}
              onClick={() => {
                if (option.rule !== rule) save.mutate(option.rule);
              }}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>
      <p className="text-muted">
        A Spec is written into the Pull Request, and you approve it before
        implement starts.
      </p>
      {shown === "always" && specAgent === false && (
        <p role="note" className="banner attention">
          This factory's definition has no spec agent, so no Spec can be written
          and new Work Items will wait for you before implement. Add a SPEC
          agent to the definition, or choose another rule.
        </p>
      )}
      {save.error && (
        <p className="form-error" role="alert">
          {save.error.message}
        </p>
      )}
    </div>
  );
}
