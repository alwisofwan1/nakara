/** What the New work form starts from: a duplicated item, or an automation to run. */
export interface Prefill {
  title: string;
  request: string;
  repo: string | null;
  automation: string | null;
}

/**
 * Run now for an automation that an event triggers: the form starts on the
 * automation, and the operator supplies the issue URL or the request.
 */
export const automationPrefill = (automation: string): Prefill => ({
  title: "",
  request: "",
  repo: null,
  automation,
});

/**
 * The form's starting values for a duplicate or an automation. A repository or automation the
 * definition no longer offers falls back to the form's "all" or "none" choice.
 */
export function prefillValues(
  prefill: Prefill,
  options: { repositories: string[]; automations: { name: string }[] },
) {
  const { title, request, repo, automation } = prefill;
  return {
    title,
    request,
    repo: repo && options.repositories.includes(repo) ? repo : "",
    automation:
      automation && options.automations.some((a) => a.name === automation)
        ? automation
        : "",
  };
}
