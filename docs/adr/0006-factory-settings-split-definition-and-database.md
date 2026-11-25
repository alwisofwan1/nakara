# Factory settings: what a factory does lives in the Definition, how Nakara limits it lives in the database

The Settings page grows from rename/delete/move to every per-factory choice the Operator makes. Each setting goes to exactly one home:

- **The Definition** holds what the **Factory** *is* and *reaches*: its description, repositories, `agentDefaults` (Harness, model, Runner, idle timeout) and **Automations** (name, **Trigger**, starting agent, enabled). The page writes these through `DefinitionService.writeDefinition` like the agent and automation editors already do: the edit lands in a temporary copy, the loader validates it, a stale page is a conflict, a **Managed Definition** commits, and the factory reloads. A **Repository Definition** is written into its checkout and shows up as uncommitted changes, as agent edits do today. Reach still follows ADR-0005: a repository or `agentDefaults` edit that widens reach waits for the Operator's approval like any other definition edit.
- **A new `factory_settings` table** holds how **Policy** limits the factory and what Nakara tells the Operator: Budget per Work Item, review/revision/run limits, the Spec rule, extra Handoff Gate checks, the notification channel and switches, and Paused. These are Nakara's rules about a factory, not part of the factory, so they work the same for Managed and Repository Definitions and never need a commit. A column left NULL falls back to today's environment default (`NAKARA_BUDGET_USD`, `NAKARA_MAX_REVIEWS`, `NAKARA_MAX_REVISIONS`, `NAKARA_MAX_RUNS`), so an instance without settings behaves exactly as before.

## Rules

1. **Snapshot at creation.** A Work Item copies the factory's limits, Spec rule and Handoff Gate checks when it is created, the way `budget_usd` and `max_runs` already are. Changing a setting never changes work already in flight; Raise budget / Raise run limit stay the per-item override.
2. **The Handoff Gate only grows.** "Work pushed to the Pull Request and CI passes" stays fixed for every factory. A factory may add *Review accepted* and *Verification passed*; it can never remove the fixed part.
3. **The Spec rule** is one of `always`, `when_asked` (today's behaviour: the Foreman decides) or `never`. A Work Item may ask for a Spec when its factory's rule is `when_asked`; it cannot opt out of `always` or into `never`.
4. **Pause stops starts, not runs.** A paused factory still takes intake, but the scheduler starts no Foreman Turn for it; Runs already started finish. Resume wakes the waiting items.
5. **No separate intake switches.** GitHub-label, Slack and Telegram intake already come from Automations with `github/issue_labeled`, `slack/message` and `telegram/message` Triggers. "Where work comes from" on Settings lists those Automations with their existing enabled switch instead of adding a second switch that could disagree.
6. **Only a human merges, and the Merge button is a human.** The Operator may merge a Pull Request at **Handoff** from the Work Item page; Nakara runs `gh pr merge` with its own token only on that click. Agents and the Foreman stay unable to merge (`run-support.ts`, `CODEX_RULES`).

## Considered options

- *Everything in `factory.yaml`.* One file to review, but a Repository Definition's limits would change through someone else's commit, Budget edits would churn git history, and the Warp definition format has no place for them.
- *Everything in the database.* Simple to write, but the description, repositories and agent defaults would drift from the Definition that agents and reviewers read, and reach would escape ADR-0005.

## Consequences

- `PolicyState` reads its limits, Spec rule and gate from the Work Item, not from `config.limits`; `Limits` in `src/domain/policy.ts` becomes per item.
- CONTEXT.md's **Handoff Gate** gains "plus the checks its factory adds"; **Paused** gains the paused **Factory**.
- The mockup's "Proposed" tags map one to one onto the issues that implement this ADR.
