---
name: code-review
description: Rubric, blocking rules and severities for reviewing a factory pull request.
---

# Code review rubric

Review the diff against the work item and, when one exists, the spec. Report findings; do not post them.

## Dimensions
- **Correctness**: the change does what the issue or spec asks, including edge cases and failure paths.
- **Spec alignment**: no missing required behavior, contradicted decision, or unrequested scope.
- **Tests**: the tests exercise the changed behavior. A bug fix has a regression test that fails without the fix.
- **Verification evidence**: the PR states which checks ran. Claims that you cannot reproduce count as unverified.
- **Security**: input validation, secrets, injection, authorization, unsafe defaults.
- **Maintainability**: follows the repository's existing patterns. No dead code, debug output or scratch files.

## Severities
- **blocking**: wrong behavior, data loss, security issue, missing required behavior, or no test for changed logic.
- **major**: likely bug or significant gap that a human should see before merge.
- **minor**: a small improvement. Report at most a few. Never report restated style preferences.

## Finding format
`path:line` · severity · problem · impact · correction. Mark each finding **unambiguous** (it can be fixed without a human decision) or **ambiguous** (it needs a product or technical decision).

## Verdict
`accepted` (no findings) · `revision needed` (only unambiguous findings) · `human decision needed` (at least one ambiguous finding).
