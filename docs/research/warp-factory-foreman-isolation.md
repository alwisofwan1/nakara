# Where Warp runs the foreman, and what it can reach

Research for Nakara's Q6: should the **Foreman** run on the host or in the agent sandbox? Gathered 2026-10-25 from docs.warp.dev (the `.md` page versions), the published `v1alpha1` JSON Schemas, and `warpdotdev/warp-factory-examples` at commit `84e7c95` (2026-08-25).

**Convention:** "Warp states" means a quoted, cited claim. **Inferred** means my reading of the sources, not something Warp says. **Not documented** means I searched and found nothing.

## TL;DR

1. Warp states that the foreman is an ordinary factory agent (`agentType: FOREMAN`), and that every agent run, the foreman's included, is "a cloud agent run" in a per-run sandbox, either Warp-hosted or on a managed self-hosted worker. It never runs on the user's machine.
2. Warp has no special placement for the foreman. It inherits the same `agentDefaults.runner` and `workerHost` as the workers, and none of the official examples override them for the foreman.
3. There is no per-agent tool allowlist in the definition format. Warp states that access comes "from its configuration and the permissions of the connected providers, never from its instructions". That configuration is per-agent `secrets`, `mcpServers`, `credentialStrategy`, repositories, `spawnableBy`, and an undocumented, schema-only `networkPolicy`.
4. GitHub access goes through a GitHub App installation token, or the triggering user's token for user-triggered runs, with `credentialStrategy` per factory and per agent. Execution secrets come from a per-agent allowlist. Warp documents no default where the foreman gets weaker or stronger credentials than the workers.
5. Warp publishes no prompt-injection guidance. Its controls are trigger gating (connected account plus team membership, bots skipped), branch protection for merges, and a caution that anyone who can comment can start an agent with the installation's full access. Spec approval is only "workflow policy in the foreman's instructions".

## 1. Is there a foreman, and where does it run?

- **Warp states** that the foreman exists: "The **foreman** is the agent that coordinates a factory's work … It delegates work to other agents, asks for your decisions when needed, and returns results." ([factory-agents](https://docs.warp.dev/factories/factory-agents/)). Its role is `agentType: FOREMAN` (alias `MAIN`): "Every factory has one foreman, which serves as its entry point and the default automation target." ([factory-as-code, `agentType`](https://docs.warp.dev/factories/factory-as-code/#agenttype))
- **Warp states** where it runs: "Each agent's run is a cloud agent run on Warp-hosted or managed self-hosted compute" ([how-factories-work](https://docs.warp.dev/factories/how-factories-work/)). "Every agent run is a standard cloud agent run on the Automation Platform", and runs execute "on Warp-hosted compute by default" ([factories overview](https://docs.warp.dev/factories/)).
- **Warp states** that the control plane and the execution plane are split: "Warp manages coordination, while a Warp-hosted sandbox or a managed self-hosted worker executes the work" ([infrastructure-and-security, Control plane and execution plane](https://docs.warp.dev/factories/infrastructure-and-security/#control-plane-and-execution-plane)). Run state, the work-item store and routing live in Warp's control plane, not in the foreman's sandbox.
- **Warp states** that the user's machine is excluded: "Unmanaged self-hosted agents and other CLI agents can't serve as a factory's execution host, but they can exchange work with a factory through Factory MCP" ([infrastructure-and-security, Choose an execution host](https://docs.warp.dev/factories/infrastructure-and-security/#choose-an-execution-host)).
- **Warp states** that the foreman and the workers share settings: the foreman's `agent.md` takes the same keys as any agent (`runner`, `workerHost`, `secrets`, `mcpServers`, …), all overriding `agentDefaults` ([factory-as-code, `agents/<name>/agent.md`](https://docs.warp.dev/factories/factory-as-code/#agentsnameagentmd)).
- **Examples:** in `00-warp-default-agents`, `01`, `02`, `03` and `07`, no `agents/foreman/agent.md` sets `runner`, `workerHost` or `secrets`. They set only `description`, `agentType` and sometimes `model`. The foreman therefore inherits the same runner as the workers: `linux-standard` (ubuntu:24.04, 4 vCPU / 8 GB) in `00` and `02`, and `workerHost: factory-worker` in `07-self-hosted-worker/factory.yaml`.
- **Warp states** that dispatch is a platform tool: "The foreman uses `run_agents` to dispatch configured factory agents … It sets `remote` to run the child in the cloud … the run uses the selected agent's environment, runner, host, harness, and model" ([creating-custom-agents, Dispatch](https://docs.warp.dev/factories/factory-agents/creating-custom-agents/#dispatch-a-configured-agent)). Generic orchestration also offers "Cloud → cloud-local", where children run "inside the parent's own cloud environment", but factory dispatch uses `remote` ([orchestration, Where parent and child agents can run](https://docs.warp.dev/platform/orchestration/#where-parent-and-child-agents-can-run)).
- **Inferred:** the foreman runs in its own per-run sandbox, separate from each worker's but of the same kind and built from the same runner image by default. Isolation is the baseline for the foreman, not an option.

## 2. Tools and permissions: foreman vs workers

- **Not documented:** a tool allowlist, read-only mode or permission profile in `agent.md`. The published `agent.schema.json` keys are exactly these: `agentType, computerUseModel, credentialStrategy, description, environmentId, harness, idleTimeoutMinutes, mcpServers, model, networkPolicy, prewarmedPool, required_repos, runner, secrets, spawnableBy, workerHost`.
- **Warp states** the principle: "Each agent reaches only the repositories, secrets, and MCP servers in its configuration … What an agent can reach comes from its configuration and the permissions of the connected providers, never from its instructions — changing what an agent is told to do doesn't change what it's able to do." ([factory-agents, Human decision points and permissions](https://docs.warp.dev/factories/factory-agents/#human-decision-points-and-permissions))
- **Warp states** what is foreman-specific: it is "the only default agent that communicates directly with you" ([factory-agents, Foreman](https://docs.warp.dev/factories/factory-agents/#foreman)). "Every default agent includes GitHub skills; the foreman also includes a Slack skill." ([factory-agents, Built-in skills](https://docs.warp.dev/factories/factory-agents/#built-in-skills))
- **Warp states** who may dispatch whom (`spawnableBy`): "Omit it to allow only the foreman, use an empty list to allow none, or list exact agent names." ([factory-as-code](https://docs.warp.dev/factories/factory-as-code/#agentsnameagentmd))
- **Examples:** the default foreman prompt has the foreman write to GitHub itself. It must "post a review on the PR yourself that contains only those findings", apply the factory label, and post an attribution comment (`examples/00-warp-default-agents/agents/foreman/agent.md`, Procedure steps 5–6). **Inferred:** Warp's foreman holds GitHub write access, not a read-only view.
- **Warp states** that Agent Profiles (command allowlists and denylists) exist for the Warp Agent ([agent-profiles-permissions](https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)), and that a cloud run combines "the environment with a host, an agent profile, and task-specific context" ([environments](https://docs.warp.dev/platform/environments/)). **Not documented:** how a factory selects an agent profile. There is no definition field for it.

## 3. Credentials

- **Warp states** four credential boundaries ([infrastructure-and-security, Credential boundaries](https://docs.warp.dev/factories/infrastructure-and-security/#credential-boundaries)):
  - **Inference credentials** are "never injected into the sandbox".
  - **Execution secrets** "are delivered from an explicit per-agent allowlist. Factory agents that don't act as a specific user receive no managed secrets by default."
  - **Harness authentication** (Claude Code, Codex) is "used inside the execution environment", separately from the secret allowlist.
  - **Repository identity**: "Runs act with the creating user's authorization … or as the agent itself for unattended work", set by `credentialStrategy`.
- **Warp states** the scope rule for `credentialStrategy`: values are `EXECUTOR` (the default) or `CREATOR`, and "Agents can override the strategy by role" ([factory-as-code, `credentialStrategy`](https://docs.warp.dev/factories/factory-as-code/#credentialstrategy)).
- **Warp states** how the GitHub token works: "Runs authenticate with the GitHub App installation. Its repositories and permissions control access; automation filters only control when work starts." ([integrations/github, Permissions](https://docs.warp.dev/factories/integrations/github/#permissions)). For `@warp-agent` runs, the run uses "a token minted for the Warp Factories GitHub App installation that delivered the event, not … the mentioning user's GitHub authorization". Runs from Slack, Linear or the local app use "the GitHub permissions of the triggering user" ([platform/integrations/github, Permissions and identity](https://docs.warp.dev/platform/integrations/github/#permissions-and-identity); [team-access-billing-and-identity](https://docs.warp.dev/platform/team-access-billing-and-identity/#team-github-authorization)).
- **Warp states** that secret lists are per-agent and replace rather than merge: factory-wide `secrets` go to every agent, `agentDefaults.secrets` is the inherited list, and "Per-agent `secrets` - Replaces the default list" ([secrets, Factory-wide and inherited access](https://docs.warp.dev/factories/secrets/#factory-wide-and-inherited-access)). Secrets are injected "as environment variables using the secret name" ([secrets](https://docs.warp.dev/factories/secrets/)). The architecture page says the sandbox "injects only the secrets the run is allowed to use" ([architecture, run lifecycle step 4](https://docs.warp.dev/platform/architecture/#cloud-agent-run-lifecycle)).
- **Not documented:**
  - Whether installation tokens are minted per run, and what their TTL is. (GitHub caps installation tokens at 1 h, but Warp does not say so.)
  - Per-agent GitHub permission narrowing, for example a read-only token for the foreman. One installation serves all agents.
  - Any default difference between the foreman's credentials and the workers'.

## 4. Untrusted input and prompt injection

- **Not documented:** any prompt-injection threat model or guidance. Searches for "injection" and "untrusted" across the factories, automation-platform, agents, enterprise and changelog doc bundles returned nothing relevant. The only hit is MCP config-edit approval gates in the local Warp app ([agents bundle, MCP security mitigations](https://docs.warp.dev/agents/capabilities/mcp/)).
- **Warp states** these gates on who can trigger work:
  - "Users still need a connected GitHub account and active membership in the factory's Warp team to trigger its GitHub automations." ([factory-as-code, `automations`](https://docs.warp.dev/factories/factory-as-code/#automations))
  - "GitHub triggers skip bot events by default" (`skip_bots` defaults to `all`).
  - "Only new content counts as a mention. Edits and mentions inside code blocks are ignored." ([integrations/github](https://docs.warp.dev/factories/integrations/github/#mention-the-factory))
- **Warp states** the residual risk: "anyone who can comment in a repository covered by the installation — and who has a connected GitHub account on that Warp team — can start an agent that acts with all the repository access granted to that team." ([platform/integrations/github, Caution](https://docs.warp.dev/platform/integrations/github/#permissions-and-identity))
- **Warp states** that the human gates are policy, not enforcement: spec approval is "Workflow policy in the foreman's instructions, which your team can change". For merging, "Your repository's permissions decide who can approve and merge … So enforce with the real controls" ([factory-agents, Human decision points](https://docs.warp.dev/factories/factory-agents/#human-decision-points-and-permissions)).
- **Schema only, not in the docs:** the factory field `restrictFollowupsToStarter`, described as "When true, only the Warp user who started a run may send it follow-ups" (`factory.schema.json`).
- **Warp states** that redaction is not a defence: "redaction is a backstop, not a substitute for narrow external permissions and rotation" ([infrastructure-and-security](https://docs.warp.dev/factories/infrastructure-and-security/#credential-boundaries)).

## 5. Runners, images, egress and isolation

- **Warp states** the runner fields: `description`, `setupCommands`, `failureSessionRetentionMinutes`, `instanceShape {vcpus, memoryGb}`, and `platform {os, arch, linux.dockerImage, linux.registryCredentialSecretName, mac.version}` ([factory-as-code, `runners/<name>.yaml`](https://docs.warp.dev/factories/factory-as-code/#runnersnameyaml)). The runner schema has no network field.
- **Warp states** that hosted runs are fresh per run: "Warp-hosted Linux runners execute the agent in a fresh Docker container"; macOS and Windows get "a fresh VM". The default image is `warpdotdev/dev-base:latest` ([runners, Operating systems](https://docs.warp.dev/factories/runners/#operating-systems)). "Warp-hosted agents run in isolated sandboxes" ([warp-hosting](https://docs.warp.dev/factories/warp-hosting/)).
- **Warp states** that egress is open by default: "Warp-hosted agents have network egress enabled by default." To allowlist traffic on your side, Warp publishes its IP ranges ([warp-hosting, Networking](https://docs.warp.dev/factories/warp-hosting/#networking)).
- **Schema only, not in the docs:** `networkPolicy` on factories and agents. Its schema description reads "An empty policy denies all network egress. If no policy applies to the agent, all egress is allowed. Network policies cannot block services required for the platform to function." It takes `allowedHosts` and `deniedHosts` (literal hosts, no wildcards or CIDRs) and `extends` Warp-managed policies such as `warp/package-registries@1.0.0` and `warp/claude-code@^1` (`common.schema.json`, `$defs.networkPolicy`). **Inferred:** per-agent egress allowlists are coming but not yet a documented feature.
- **Warp states** how isolation differs by self-hosted backend ([execution-security](https://docs.warp.dev/platform/execution-security/#backend-specific-security-considerations); [infrastructure-and-security, Managed self-hosting structures](https://docs.warp.dev/factories/infrastructure-and-security/#managed-self-hosting-structures)):
  - **Docker:** "Each task runs in its own container. Containers are removed after execution by default." Treat Docker socket access "as elevated host access".
  - **Kubernetes:** each task runs as a Job.
  - **Direct:** "does not provide container-level isolation … shares the host OS and kernel", and starts tasks with only `HOME`, `TMPDIR` and `PATH`, so "`WARP_API_KEY` [is] not passed to tasks".
  - **Unmanaged:** "Agents inherit the host's network access, tools, and credentials."
- **Warp states** that self-hosted network policy is the operator's job: workers need outbound access only, to `app.warp.dev`, `rtc.app.warp.dev`, `sessions.app.warp.dev`, `oz.warp.dev`, Docker Hub, `storage.googleapis.com` and `github.com`. For the Command backend, "The external runtime owns task isolation, credentials, network policy, and cleanup." ([execution-security, Network requirements](https://docs.warp.dev/platform/execution-security/#network-requirements))
- **Not documented:** the hosted sandbox technology (gVisor, Firecracker, …), and any hosted egress filtering beyond the schema-only `networkPolicy`.

## 6. Workspace model

- **Warp states** that each run gets a fresh clone and setup: "Warp provisions a sandbox and clones the repositories before setup. The runner's `setupCommands` run in order, followed by the environment's setup commands" ([runners, How runners fit](https://docs.warp.dev/factories/runners/#how-runners-fit-into-cloud-agent-runs)). Environment settings "create a fresh workspace for each run" ([environments](https://docs.warp.dev/platform/environments/)).
- **Warp states** that the sandbox is torn down: "repositories are cloned into an isolated per-run sandbox and destroyed with it" ([architecture, Data security](https://docs.warp.dev/platform/architecture/#data-security-and-boundaries)). With snapshotting enabled, workspace changes are captured for Handoff before the sandbox is destroyed (lifecycle step 9).
- **Warp states** these options for caches and sharing:
  - On self-hosted Docker, `-v /opt/shared-cache:/cache:ro` adds volume mounts ([self-hosting/reference](https://docs.warp.dev/factories/self-hosting/reference/)).
  - On Direct, `target_dir` gives a shared working directory, and the `direct-monorepo-worktrees` page covers worktree setup and teardown hooks ([direct-monorepo-worktrees](https://docs.warp.dev/factories/self-hosting/direct-monorepo-worktrees/)).
  - On hosted macOS, "Downloads from Homebrew and popular language package managers are cached automatically."
- **Schema only:** `prewarmedPool` ("keeps a set of sandboxes ready for future runs … Each Agent has a separate pool") and `required_repos` ("Repositories … that must be eagerly prepared for every run").
- **Warp states** that agents coordinate by messages, not shared files: "agents don't read each other's transcripts or live working trees. Instead, they exchange explicit messages" ([orchestration, Messaging](https://docs.warp.dev/platform/orchestration/#messaging-between-agents)).

## 7. Relevant `factory.yaml` and `agent.md` fields

| Field | Level | Relevance | Source |
|---|---|---|---|
| `agentType: FOREMAN` | agent | Marks the foreman; one per factory | docs + schema |
| `runner`, `workerHost`, `environmentId` | agentDefaults / agent / automation | Placement; the foreman can be pinned like any agent | docs + schema |
| `secrets`, `mcpServers` | factory / agentDefaults / agent | Per-agent allowlists; the agent-level list replaces the default | docs + schema |
| `credentialStrategy` (`EXECUTOR`/`CREATOR`) | factory / agent | Whose GitHub identity a run uses | docs + schema |
| `harness.auth.source` (`managedSecret` / `workerEnvironment`) | agentDefaults / agent | Where the Claude/Codex key comes from | docs + schema |
| `spawnableBy` | agent | Which agents may dispatch this one (default: foreman only) | docs + schema |
| `networkPolicy {allowedHosts, deniedHosts, extends}` | factory / agent | Egress allowlist; empty denies all | **schema only** |
| `restrictFollowupsToStarter` | factory | Only the starter may send follow-ups | **schema only** |
| `blueprint` | factory | Explicit stage graph the foreman executes; derives `spawnableBy` | **schema only** ("Not yet available on every deployment") |
| `prewarmedPool`, `required_repos` | agent / automation | Warm sandboxes; eager clones | **schema only** |

## Implications for Nakara's Q6 (foreman on host vs in sandbox)

What Warp does that applies here:

- **Warp's foreman is never a host process.** It is a cloud run in its own throwaway sandbox, with the same runner type as the workers. Warp states that the closest analogue to option (b), an agent with host access, cannot be a factory execution host, and that such agents "inherit the host's network access, tools, and credentials." On placement, Warp's practice matches **option (a)**.
- **The foreman's power is in the control plane, not in its sandbox.** `run_agents`, run state and messaging are platform services reached from inside the sandbox. Nakara's equivalent is the `nakara` MCP server plus `src/domain/policy.ts` on the host. Running the foreman in a container that reaches that MCP endpoint over a narrow channel keeps the same split: orchestrator and policy on the host, the LLM in the sandbox.
- **Warp enforces through configuration, not instructions.** This is Warp's one explicit security principle, and it argues against relying on a `claude -p` allowlist on the host. That allowlist is harness configuration in the same process that holds the operator's personal `gh` token and full host network.
- **Warp's foreman credentials are not narrower than the workers'.** The default foreman posts PR reviews and labels with the installation token, and Warp documents no read-only foreman. Nakara can do better: the foreman acts only through MCP tools, so it needs no write token, and arguably no GitHub token at all if the orchestrator puts the issue and PR context into the turn.
- **Spec approval is enforced more strongly in Nakara.** Warp's spec gate is only prompt policy; Nakara already enforces it in code (`policy.ts`). Q6 is about the remaining blast radius: what an injected foreman can read or exfiltrate *before* policy is involved. Today that is everything the operator's host user can read and reach.

| | (a) Sandbox foreman | (b) Host foreman, tightened |
|---|---|---|
| Matches Warp | Yes: per-run sandbox, same runner as workers | No: closest to Warp's "unmanaged", excluded as a factory host |
| GitHub credential | Agent token or none; can be narrower than Warp's | Operator's personal token unless replaced |
| Egress | Existing allowlist proxy (Warp has only a schema-level `networkPolicy`) | Full host network |
| Exfiltration surface | Mounted worktrees only (read-only) | Whole home directory, SSH keys, `~/.aws`, … within the tool allowlist |
| Cost | Container start per turn. Warp's mitigation is `prewarmedPool`; for Nakara, a warm container or accepting the latency | None |
| New work | Reach the MCP server from the container; read-only mounts; `--resume` session storage inside or mounted | Swap the token, harden the allowlist; still one misconfiguration from host access |

**Evidence-based reading:** Warp's design supports (a). Warp gives the foreman no special trust: same sandbox, same per-agent configuration knobs, and real controls outside the prompt. Option (b) can only be justified by latency or simplicity. If (b) is chosen anyway, the minimum to approach Warp's posture is a dedicated read-only GitHub token instead of the personal one, plus an egress restriction. Warp documents no foreman-specific hardening to copy.

## Sources

Docs pages were fetched as Markdown by appending `.md`, on 2026-10-25.

- https://docs.warp.dev/factories/
- https://docs.warp.dev/factories/how-factories-work/
- https://docs.warp.dev/factories/factory-agents/
- https://docs.warp.dev/factories/factory-agents/configuration/
- https://docs.warp.dev/factories/factory-agents/creating-custom-agents/
- https://docs.warp.dev/factories/factory-as-code/
- https://docs.warp.dev/factories/infrastructure-and-security/
- https://docs.warp.dev/factories/runners/
- https://docs.warp.dev/factories/secrets/
- https://docs.warp.dev/factories/warp-hosting/
- https://docs.warp.dev/factories/integrations/github/
- https://docs.warp.dev/factories/self-hosting/ (also `/reference/`, `/managed-docker/`, `/managed-direct/`, `/direct-monorepo-worktrees/`)
- https://docs.warp.dev/platform/architecture/
- https://docs.warp.dev/platform/execution-security/
- https://docs.warp.dev/platform/orchestration/
- https://docs.warp.dev/platform/environments/
- https://docs.warp.dev/platform/integrations/github/
- https://docs.warp.dev/platform/team-access-billing-and-identity/
- https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/
- Doc bundles searched: https://docs.warp.dev/_llms-txt/{factories,automation-platform,agents,enterprise,changelog}.txt
- JSON Schemas: https://app.warp.dev/api/v1/factory-files/schemas/v1alpha1 (`agent`, `factory`, `common`, `runner`, `automation`)
- https://github.com/warpdotdev/warp-factory-examples @ `84e7c95`: `examples/00-warp-default-agents`, `02-sdlc-issue-to-pr`, `03-multi-harness`, `07-self-hosted-worker`
- Searched without relevant results: a warp.dev web search for foreman security and prompt injection, which found only the marketing page https://warp.dev/factories and an unrelated terminal CVE. I did not review warp.dev blog posts individually.
