# Nakara

A self-hosted software factory: requests come in as **Work Items** and leave as reviewed draft **Pull Requests** that a human merges. It follows the concepts of Warp Factories.

## Language

### Factories and definitions

**Factory**:
A named unit that owns a set of repositories and turns their requests into pull requests.
_Avoid_: Project, workspace, pipeline

**Factory Name**:
The display name of a **Factory**; renaming changes only this.

**Factory Slug**:
The permanent identifier of a **Factory** in its URLs.

**Factory Label**:
The GitHub label (`factory:<alias>`) that routes an issue to a **Factory**; it does not change on rename.
_Avoid_: Alias (the definition format's spelling of it)

**Definition**:
The files (`factory.yaml`, agents, automations) that describe what a **Factory** does.
_Avoid_: Config, factory config

**Managed Definition**:
A **Definition** that Nakara stores and versions itself.
_Avoid_: Local definition

**Repository Definition**:
A **Definition** kept in a folder of one of the **Factory**'s own repositories.

**Agent**:
A named worker in a **Definition**, with one **Agent Type** and one **Harness**.
_Avoid_: Bot, worker, role

**Agent Type**:
The kind of job an **Agent** does: foreman, triage, spec, implement, review, verify or custom.

**Foreman**:
The **Agent** that decides the next step of a **Work Item**, acting only through factory actions.
_Avoid_: Orchestrator (that is the Nakara process that applies **Policy**), manager, coordinator

**Harness**:
The coding CLI an **Agent** runs on (Claude Code, Qwen, Codex).
_Avoid_: Runtime, backend, provider

**Runner**:
Where an **Agent**'s **Runs** execute: a throwaway sandbox container, or the host as the **Operator** (no sandbox).
_Avoid_: Executor, environment

**Automation**:
A **Definition** entry that creates **Work Items** from a **Trigger**.

**Trigger**:
The external event or schedule that fires an **Automation**.

**Template**:
A starting **Definition** that the New factory wizard or scaffolder copies.

### Work

**Work Item**:
One request moving through a **Factory**, from intake to a merged or closed pull request.
_Avoid_: Task, ticket, job, issue

**Tracking Issue**:
The GitHub issue that records a **Work Item** for people outside Nakara.
_Avoid_: calling the issue a "work item"

**Intake**:
The way a **Work Item** arrives: manual, GitHub label, schedule or Telegram.

**Stage**:
Where a **Work Item** is in the flow: intake, triage, planning, building, reviewing, handoff, complete or cancelled.

**Blueprint**:
A factory's **Stages** and the moves between them that the **Foreman** is designed to make, with how often each move and each stage's **Agent Runs** were recorded.

**Status**:
Whether a **Work Item** can progress: active, waiting, paused or done.
_Avoid_: using "state" for this

**Waiting**:
The **Status** of a **Work Item** that needs a human's input or decision to continue, including one with nothing in progress.
_Avoid_: Blocked, stalled

**Paused**:
The **Status** of a **Work Item** the factory stopped because it hit a safety limit, such as its **Budget**.
The Operator can also pause a **Factory**, which stops its **Work Items** from starting **Runs**: running work finishes, and new **Work Items** wait in Intake until the Operator resumes it.
_Avoid_: Suspended, halted

**Spec**:
The written plan for a **Work Item**, committed to its **Pull Request**, that a human must approve before implementation.
_Avoid_: Design doc, plan, spec PR

**Pull Request**:
The single pull request that carries a **Work Item**'s change, first as a draft and later ready for a human to merge.
_Avoid_: PR as a separate "spec PR" and "implementation PR"

**Event**:
A fact recorded on a **Work Item** that wakes the **Foreman**.

**Foreman Turn**:
One wake-up of the **Foreman** that handles the pending **Events** of a **Work Item**.

**Run**:
One execution of an **Agent** for a **Work Item**: either a **Foreman Turn** or an **Agent Run**.

**Agent Run**:
A **Run** of a non-foreman **Agent** dispatched by the **Foreman**.

**Follow-up**:
A new **Agent Run** that continues an earlier one in the same agent session.
_Avoid_: Rerun

**Retry**:
The operator's **Follow-up** of a failed **Agent Run**.

**Revision**:
A **Follow-up** that fixes what a **Review** asked to change.

**Push-only Follow-up**:
A **Follow-up**, offered once after a **Handoff** is refused because the work is not on the **Pull Request**, that only pushes it; it is not a **Revision**.

**Review**:
An **Agent Run** that judges a pull request and states a **Review Verdict**.

**Review Verdict**:
The result of a **Review**: accepted, revision needed, or human decision needed.

**Verification**:
An **Agent Run** that proves a change works by running it, without stating a **Review Verdict**.
_Avoid_: using "review" for this

**Budget**:
The spending cap of a **Work Item**, failed **Runs** included.

**Policy**:
The rules in code that allow or refuse every **Foreman** action.
_Avoid_: Guardrail (as a noun for a single rule, use "policy rule")

**Handoff**:
The **Stage** where the factory has marked the pull request ready and a human must merge or close it.

**Handoff Gate**:
The conditions a **Pull Request** must meet before **Handoff**: the work is pushed to it and its CI passes.
_Avoid_: CI gate, merge gate

### Humans

**Operator**:
The one person who runs a Nakara instance and the only one allowed to use its web UI and API.
_Avoid_: Admin, owner, user

**Requester**:
The human accountable for a **Work Item**, who answers its **Questions** and reviews its **Pull Request**.
_Avoid_: Author, reporter, user

**Reporter**:
The person who wrote a **Tracking Issue**; not necessarily the **Requester**.

**Inbox**:
The list of things a human must act on across all **Factories**.

**Approval**:
A decision a **Work Item** waits on: a **Spec** to approve or a **Question** to answer.

**Question**:
An **Approval** in which the **Foreman** asks a human for information.

**Message**:
A line in the conversation of a **Work Item**, written by the factory or a human.

## Relationships

- A **Factory** has exactly one **Definition** and owns one or more repositories; a repository belongs to at most one **Factory**
- A **Definition** has exactly one **Foreman** and zero or more other **Agents** and **Automations**
- A **Work Item** has zero or one **Tracking Issue**
- A **Work Item** targets exactly one repository and has at most one **Pull Request**; work across two repositories is two **Work Items**
- A **Work Item** belongs to exactly one **Factory** and has many **Events**, **Runs**, **Messages** and **Approvals**
- An **Event** is handled by exactly one **Foreman Turn**; a **Foreman Turn** may dispatch **Agent Runs**
- An **Agent Run**'s report is an **Event** that wakes the next **Foreman Turn**
- A **Work Item** gets a capped number of **Reviews** (one by default) and **Revisions**; a review run that is stopped or fails before stating a **Review Verdict** is not a **Review** and does not count
- A **Work Item** with a **Pull Request** reaches complete only after a human merges it; one without a **Pull Request** completes with a summary

## Example dialogue

> **Dev:** "When a **Review** says revision needed, does the **Foreman** dispatch a fresh implement **Agent Run**?"
> **Domain expert:** "No — it sends a **Follow-up** to the same implement session, and that counts as a **Revision**. A **Follow-up** after a restart is not a **Revision**."
> **Dev:** "And if the **Budget** runs out mid-**Revision**?"
> **Domain expert:** "The **Work Item** is paused and shows up in the **Inbox**; nothing merges on its own."

## Flagged ambiguities

- "task" appears in the `complete_task` action but means **Work Item** — resolved: use **Work Item**.
- "role" is used both for **Agent Type** and for foreman-vs-agent on a **Run** — resolved: **Agent Type** for the job; "role" only in code.
- "handoff" is both a **Stage** and a **Foreman** action — resolved: the action moves the **Work Item** to the **Handoff** stage, and only when CI passes.
- "stopped" vs "cancelled" — resolved: a stopped **Run** is a cancelled **Run** ended by the operator; metrics report it separately.
- The Warp-derived agent prompts called the **Foreman** "the orchestrator" and the **Tracking Issue** "the work item" — resolved: the bundled definition now uses **Foreman** and **Tracking Issue**.
- "requester" was the issue author for GitHub intake and the string "schedule" for scheduled work — resolved: the **Requester** is whoever applied the **Factory Label**, and scheduled work has none.
- "Harness" `claude` and `claude-code` name the same CLI — resolved: one **Harness**, two spellings in the definition format.
- "spec PR" in the UI suggested a second pull request — resolved: the **Spec** lives in the one **Pull Request**; the UI labels its link "Spec". When an implement run opens its own PR anyway, the UI still shows both links, as a tolerated deviation.
