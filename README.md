# Nakara

A self-hosted software factory: requests and labeled GitHub issues go in, and
reviewed **draft pull requests** come out. A human always merges.

Nakara follows the concepts of [Warp Factories](https://docs.warp.dev/factories/)
and reads a compatible subset of its definition format (`v1alpha1`). The eight
trees in `warpdotdev/warp-factory-examples` load unchanged. Execution is local:
agents run Claude Code headless (`claude -p`) in a git clone per work item.

## How it works

```
 web form ─┐                                    ┌─► triage   (claude haiku)
 GitHub    ├─► work item ─► event ─► foreman ───┼─► spec     (claude opus) ─► inbox: approve spec
 label     ┘                        turn        ├─► implement(claude opus) ─► draft PR
                                       ▲        └─► review   (claude opus) ─► findings
                                       └──── agent reports, human answers, PR merged
```

- **Foreman (LLM, event-driven).** Each event (new work, an agent's report, an
  answer, a merge) wakes one foreman turn: `claude -p --resume <session>`. The
  foreman acts only through the `nakara` MCP tools (`dispatch_agent`,
  `follow_up`, `post_update`, `ask_human`, `request_spec_approval`,
  `record_refs`, `handoff`, `complete_task`). Agents run after the turn ends,
  and their reports wake it again.
- **Guardrails in code (hybrid).** `src/domain/policy.ts` decides every action.
  The MCP tool refuses a violation immediately, and the orchestrator checks the
  action again before applying it:
  - implementation waits for an approved spec (approval only via the inbox),
  - review runs at most as many times as the item's review limit (once by default), and only after a PR is recorded; a re-review uses one review, whether the foreman dispatches the review agent or sends it a follow-up; only a review that ran counts: a review run that is stopped, cancelled or fails without a verdict gives its review back, and the foreman is told it can run the review again,
  - review fixes go to the same implementation agent through `follow_up`, with a revision cap; a revision that answers human feedback on the PR (below) does not count toward it,
  - a budget cap per work item (set in New work; default from the factory's Settings, else `NAKARA_BUDGET_USD`) that includes failed runs; a claude run stopped before its final result is charged an estimate from the token usage it streamed,
  - a run limit per work item (default from the factory's Settings, else `NAKARA_MAX_RUNS`) that counts foreman turns and agent runs, failed and interrupted ones included, so items on harnesses without a per-token bill (codex, qwen) also stop; the item pauses until the operator presses Raise run limit,
  - a work item with a PR completes only after a human merges it (one without a PR, such as an answered question, completes with a summary), and nothing in the factory merges.
- **Follow-ups keep context.** A follow-up resumes the agent's own Claude Code
  session, as Warp's foreman procedure requires.
- **Human PR feedback starts a revision.** With the PR checks, at the same
  interval (`NAKARA_POLL_SECONDS`), Nakara reads the open, unmerged PR of each
  open work item: reviews that request changes or comment with a body, inline
  review comments, and plain PR comments, newer than a cursor kept per item
  (`pr-feedback:<item id>` in kv). The first read of an item only sets the
  cursor, so feedback from before is not replayed. A review still pending
  (started but not submitted) and its inline comments wait until it is
  submitted. Only feedback from a login with write, maintain or admin access
  to the repository counts; bots and Nakara's own comments (evidence) are
  ignored. Who else counts depends on whether each login Nakara acts as (the
  factory's agent token and `NAKARA_FOREMAN_GH_TOKEN`) is shared or distinct.
  The rule: a Nakara login is *shared* when it is your own login, the one
  `gh` acts as in Nakara's environment without those tokens (`gh api user`);
  any other Nakara login is *distinct*. To read your login Nakara empties
  `GH_TOKEN` or `GITHUB_TOKEN` when it holds an agent or foreman token, so
  exporting a bot's token there never makes the bot you; any other token in
  them stays, so you can be logged in through `GH_TOKEN` alone. Do not put
  another token of the agent or foreman account there: Nakara cannot tell it
  is not yours.
  - *Distinct identity* (an own or shared agent token, or a foreman token, of
    another account, a bot or GitHub App): every review and comment from a
    writer counts, and that login is always ignored, even when its body starts
    with `/nakara`. An agent's reply is not new feedback, and an agent that
    posts `/nakara` past the `gh` guard (below) cannot start a revision loop.
  - *Shared identity* (no own or shared agent token, so agents act as your gh
    login, or a token of your own account, such as your fine-grained token): a
    review or comment from that login counts only when its body starts with
    `/nakara` (any case, after leading whitespace). The text after
    `/nakara` is the feedback; a bare `/nakara` counts too. GitHub does not let you request changes on a
    pull request opened under your own login, so here feedback arrives as
    comments, inline comments or "Comment" reviews that start with `/nakara`.
    A token of another writer's account counts as distinct: that person
    comments from a login of their own.

  Nakara reads your login only for a `/nakara` remark from one of its own
  logins. When it cannot read it, that poll reads nothing and the next poll
  reads the same remarks again, so the remark is neither lost nor counted
  unchecked. `/nakara` from any other writer counts too, so you can always
  use it. Nakara and its agents never post a body that starts with `/nakara`: the `gh`
  that agents and the foreman run is a guard that refuses such a comment,
  review or API body, and Nakara escapes its own comments (`\/nakara`). The
  guard sees only `gh`, so with a shared identity an agent that posts another
  way could still start a revision loop that only the run limit and the budget
  stop. **Give agents and the foreman tokens of a separate account** (a bot
  account or a GitHub App with write access) for the setup without that risk. New
  feedback becomes one `pr_feedback` event with each author, review state,
  comment, file and line, and link. It wakes the foreman, and an item at
  handoff becomes active again; a completed or cancelled item is not reopened.
  The foreman sends it to the implementation agent with `follow_up` and
  `human_feedback: true`, which Policy accepts only while feedback is
  unanswered. The follow-up answers it only when its run succeeds: a run that
  fails or is stopped leaves the feedback unanswered, so the foreman can send
  it again, and feedback that arrives while the revision runs waits for its
  own follow-up. It does not count toward the revision cap, but it counts
  toward the budget and the run limit. The agent replies on the PR where a
  comment is answered by a reply, and the normal review and handoff rules
  apply again.
- **Durable state.** SQLite (`node:sqlite`) holds work items, events, runs,
  messages and approvals. After a restart, pending events and queued runs continue.
- **Restarts do not fail work.** On SIGTERM Nakara drains: it starts no new
  foreman turn or agent run and gives the ones in flight `NAKARA_DRAIN_SECONDS`
  to finish (a second signal skips the wait). A run still going then, or left
  running by a crash, ends `interrupted`: an agent run with a session gets a
  queued follow-up that continues it in that session, and a foreman turn's events
  are handled again. Neither reaches the foreman as a failure, and the follow-up
  does not count as a revision. Only an agent run that had not started a session
  fails.
- **Several factories, one process.** Every registered factory gets its own
  orchestrator, which loads, validates and reloads that factory's definition
  from the factory's definition directory, and creates its work in that
  factory. The store, the run queue and its slots (`NAKARA_CONCURRENCY`, or
  the value saved on Settings) are shared: one scheduler starts the work of every factory. A factory whose
  definition does not load shows its errors on its Definition page and in a
  banner; its own work waits, and the other factories keep running.
  `/healthz` reports `definition: true` only when every factory has a valid
  definition, and each factory's state under `factories`: `definition` and
  `agentToken`, the source of its agent token (`own`, `shared`, `personal` or
  `none`, see [Security](#security)). GitHub intake polls
  each factory's repositories for its own `factory:<alias>` label (unless an
  automation's trigger filters on other labels) and creates the work in that
  factory. Only a labeler with write, maintain or admin access to the
  repository starts work: a label from anyone else, from a bot (`[bot]`
  login, unless the trigger lists it under `filter.bots`) or from an unreadable
  label history is ignored and logged as `intake.label_refused`; the issue is
  judged again only when its label is applied again. An issue whose body
  someone without write access edited after the label was applied still
  becomes a work item, flagged "Request changed after labelling" in the Inbox
  and on the item page, with a message showing the edit. Telegram intake creates
  work in the first factory for now.
- **One factory per repository.** A definition claims the repositories in its
  `factory.yaml` and in the `repos` filter of its GitHub triggers. Claiming a
  repository that another factory claims is a definition error on the file
  that claims it, naming the owner (`repository owner/name is already owned by
  the factory "<Name>"`); names compare case-insensitively. Ownership follows
  the definitions that are running: at startup factories load in registry
  order, so the first one to claim a repository owns it, and a refused
  definition keeps the factory's last valid one running. If the owner has no
  running definition (its definition failed to load at startup), the
  repository is free: another factory can claim it, and then owns it.
  The registry reads the factories at startup, and the New factory wizard
  registers the ones it creates while Nakara runs. Work of a factory added to
  the database any other way waits for a restart, and the log warns
  (`registry.unknown_factory`).
- **New factory wizard** (**+** next to Factories). Its choices stay in the
  page address until **Create factory**, so leaving it writes nothing. Create
  runs a job: write the definition, validate it, clone the repositories,
  create the `factory:<Name>` label in each (an existing label is kept), then
  register the factory and start its intake. A failed step shows its error,
  and Retry resumes from it; the job is kept in the database, so a restart in
  the middle can be retried too. Or change the choices and Create again: a
  failed attempt that never registered its factory is replaced, and its folder
  is rewritten. A folder with other files is refused.
  - A Nakara-managed definition lives in `$NAKARA_DATA_DIR/factories/<slug>/`.
    It is a local git repository: every edit on the web is a commit, so its
    history exists without GitHub.
  - A definition kept in a repository is written into Nakara's own clone of
    that repository, `$NAKARA_DATA_DIR/checkouts/<owner>/<name>/<folder>`.
    Nakara does not commit or push it: commit and push the folder from that
    clone yourself to keep it with your code. A clone kept from an earlier
    factory is fetched first, and refused while it has uncommitted changes.
  - Telegram messages still go to the default factory, so the wizard shows
    Telegram as "Default factory only (not yet)"; per-factory routing is #28.
- **Factory Settings** (`/f/<slug>/settings`). Rename the factory and change
  its avatar; the slug and every URL stay. Move a Nakara-managed definition
  into a folder of one of its repositories (written into Nakara's clone as
  above). Once the copy loads and the factory runs it, the managed folder, with
  its git history, is archived in `$NAKARA_DATA_DIR/archive/factories/<slug>`
  (`<slug>-2`, … when that exists), never deleted. Delete the factory with its
  closed work: refused for the default factory, and while it has active items
  or runs. A `pre-delete-<slug>` database snapshot is taken first. A managed
  definition is deleted with it; a repository folder is left as it is.

## Run

Requirements: Node ≥ 24.11 (`mise` pins 24.15), `git`, `gh` (authenticated),
and `claude`. The `qwen` harness runs `NAKARA_QWEN_BIN` (default `claude-qwen`): a
wrapper you provide that starts Claude Code against your own Qwen gateway (`ANTHROPIC_BASE_URL`).

```bash
npm ci
npm run validate -- factory          # check a definition tree
npm run build
npm start                            # http://127.0.0.1:7788
```

1. Add repositories to `factory/factory.yaml`, then reload them on the **Definition** page.
2. Open **New work**, or label a GitHub issue `factory:Nakara` (polled every 60 s).
3. Answer questions and approve specs in the **Inbox**. Merge the PR on GitHub.
   The merge wakes the foreman, which then completes the work item.

To script a factory's definition from a template, use the scaffolder the
setup wizard uses. It validates the tree with the loader before it writes
anything:

```bash
npm run scaffold -- ~/defs/shop --name "Web Shop" --repo acme/shop \
  --template nakara --disable spec --harness triage=claude \
  --intake github,telegram --schedule "0 2 * * 1"
```

Templates: `nakara` (the bundled agents), `warp` (shallow-clones
`warpdotdev/warp-factory-examples`; `--example` picks the folder, the MIT notice
is kept), `import --from <dir>` (changes only the options you pass) and `blank`
(`factory.yaml` and a foreman). Implement and the foreman are always on.

### Development checks

Use the Node version pinned in `mise.toml` (`mise install`), then run:

```bash
npm ci
npm run build                       # compile web assets for server tests
npm run check                       # Biome formatting and recommended lint rules
npm run typecheck
npm test
```

Run `npx biome format --write .` to format supported files. `npm run ci` runs
these checks plus the web checks below, in order, stopping at the first failure.
CI runs that same script on every pull request and on pushes to `main`; while
GitHub Actions is unavailable, run it locally before merging. Markdown
formatting is disabled because Biome currently rewrites YAML frontmatter
indentation in the factory definitions.

### React web development

The React shell lives in `web/`; the existing Hono process serves its JSON API
and the remaining server-rendered pages. In two terminals:

```bash
NAKARA_BASE_PATH= npm run dev:server # Nakara on 127.0.0.1:7788
npm run dev                         # Vite on localhost:5173
```

Vite proxies `/api` (including SSE) and the legacy pages to Nakara on
`NAKARA_PORT` (default `7788`) with the browser's `Host`, and the API needs the
token even on loopback. Start the server with
`NAKARA_ALLOWED_HOSTS=localhost:5173` and open `http://localhost:7788/?token=…`
once so the browser holds the cookie (cookies ignore the port, so `localhost:5173`
sends it too); start Vite with `NAKARA_DEV_TOKEN=$(cat $NAKARA_DATA_DIR/token)`
for its own factory lookup. For a
production build, run `npm run build` then `npm start`. The build writes
`dist/web`. The service does not build: `scripts/deploy.sh` builds each
release outside it (see [Deploy](#deploy)). The base path is
injected at runtime, so the same build works with
`NAKARA_BASE_PATH=/proxy/7788 npm start`, both directly at `/proxy/7788/`
and behind a proxy that strips that prefix.

Factory pages live under `/f/<slug>/` (`activity`, `agents`, `automations`,
`definition`), and `/` opens the first factory's Activity. The old paths
(`/activity`, `/agents/…`, `/automations`, `/definition`) redirect to the first
factory. Inbox (`/inbox`), Runs (`/runs`) and the item and run pages
(`/items/:id`, `/runs/:id`) have no factory prefix: item and run ids are global,
so links in GitHub comments and Telegram keep working. Inbox and Runs span all
factories and filter by one with `?factory=<slug>` (also on `/api/inbox` and
`/api/runs`). The sidebar lists the factories with their avatars under
**Factories**. A factory's API lives under `/api/f/<slug>/` (`agents`,
`automations`, `definition`, `items`, `new-work`).
`/api/status` exposes the status DTO, with each factory's definition state
under `factories`; `/api/events` sends thin change
notifications (`status`, `item`, `run`) with a 15-second heartbeat.
Reconnections invalidate status again so changes missed while offline are read.
`/api/runs/:id` returns the run DTO, `POST /api/runs/:id/follow-up` queues a
follow-up into the agent's session through the foreman's `follow_up` policy
(refusals are `409 policy`), and `/api/runs/:id/log` tails the transcript as
SSE: each event carries complete lines and the byte offset after them as its
id, so a reconnect resumes from `Last-Event-ID` (or `?offset=`). The stream
sends `event: end` and closes once the run has finished.
The last GitHub poll result is stored in SQLite: after a restart, the footer and
`/healthz` show the previous process’s last poll until a new poll completes.

Web checks (after `npm ci`):

```bash
npm run build
npm run check                       # Biome, including boundary rejection tests
npm run typecheck
npm test                            # node:test, including API/read-model/SSE tests
npm run test:web                     # Vitest query invalidation tests
npx playwright install chromium     # use --with-deps on a fresh Linux machine
npm run test:smoke                   # root + /proxy/7788 + Vite, desktop + 390px
```

The smoke fixture uses the real Store, poller and HTTP server, with external
intake and agent execution disabled. CI uploads desktop, mobile and open-menu
screenshots from `test-results/`. Biome checks accessibility, sorts Tailwind
classes and rejects raw palette colors, arbitrary values and server imports.
`npm run check` also parses every CSS file under `web/`, rejecting arbitrary
`@apply` utilities and color literals outside `@theme` (including named colors,
hex and color functions); `var(...)`, `currentColor` and `transparent` remain
available for token references and compositing.
Only `import type` from `src/web/api.ts` may cross into `web/`; client response
types are inferred through `hc<AppType>`. Named spacing/radius tokens mirror the
existing shell; the default Tailwind palette and dimension scales are reset.

### Configuration (environment)

| Variable | Default | |
|---|---|---|
| `NAKARA_HOST` / `NAKARA_PORT` | `127.0.0.1` / `7788` | Bind address |
| `NAKARA_BASE_PATH` | `""` | Link prefix behind a path proxy, e.g. `/proxy/7788` |
| `NAKARA_PUBLIC_URL` | `""` | External URL of the web UI, base path included, e.g. `https://code.example.com/proxy/7788`. Telegram notifications link to the Work Item page under it |
| `NAKARA_ALLOW` | `""` | Non-loopback peer IPs allowed (each must present the token) |
| `NAKARA_ACCESS_TEAM_DOMAIN`, `NAKARA_ACCESS_AUD`, `NAKARA_ACCESS_EMAILS` | `""` | Behind Cloudflare Access: the team domain (`https://<team>.cloudflareaccess.com`), the Access application's audience tag and comma-separated Operator emails. A request with a valid `Cf-Access-Jwt-Assertion` for them needs no token; a page visit also sets the cookie. Set all three or none |
| `NAKARA_ALLOWED_HOSTS` | `""` | Extra `Host` header values (`host:port`, comma-separated) the web server answers to, besides `NAKARA_HOST`, loopback names on `NAKARA_PORT` and the `NAKARA_PUBLIC_URL` host; for a dev proxy or a hostname you serve under yourself |
| `NAKARA_DATA_DIR` | `~/.local/share/nakara` | DB, token, clones, logs |
| `NAKARA_DEFINITION_DIR` | `factory` | Definition root (`factory.yaml`) of the first factory when migration 005 registers it; afterwards each factory loads its definition from its registered directory. When it is set and names another directory than the first factory's registered one, startup logs `startup.definition_dir_ignored` and `/healthz` lists the warning; the registered directory is used |
| `NAKARA_BUDGET_USD` | `15` | Default budget of a work item, failed runs included. New work can set another one; existing items get this value when migrated. This and the three limits below are defaults: a factory's Settings → Limits can override them for its new work items, and work items keep the limits they were created with |
| `NAKARA_MAX_RUNS` | `50` | Default run limit of a work item: foreman turns and agent runs, failed and interrupted ones included. At the limit the item pauses until Raise run limit adds 10; existing items get this value when migrated. Replaces `NAKARA_MAX_FOREMAN_TURNS` |
| `NAKARA_MAX_REVIEWS` / `NAKARA_MAX_REVISIONS` | `1` / `2` | Default review policy of a work item; existing items get these values when migrated |
| `NAKARA_CONCURRENCY` | `2` | Default number of concurrent agent runs, across all factories. Settings (in the sidebar) can override it with a value from 1 to 10, saved in the database and applied on the next scheduler pass without a restart; clearing the field returns to this default. Lowering it stops no run: nothing new starts until fewer runs than the limit are running |
| `NAKARA_POLL_SECONDS` | `60` | GitHub polling interval |
| `NAKARA_PUMP_SECONDS` | `15` | Safety-net scheduler interval; the scheduler also runs after every state change |
| `NAKARA_DRAIN_SECONDS` | `600` | On SIGTERM, how long runs in flight get to finish before they are interrupted and resumed after the restart. Keep `TimeoutStopSec` in the systemd unit above it |
| `NAKARA_GITHUB_MIRROR` | `true` | Mirror foreman updates to the source issue |
| `NAKARA_SLACK_ENABLED` | `true` | Kill switch for the [Slack](#slack) bridge; its tokens live in the secret store |
| `NAKARA_BACKUP_DIR` | `$NAKARA_DATA_DIR/backups` | Database snapshots, see [Backup and restore](#backup-and-restore) |
| `NAKARA_BACKUP_INTERVAL_HOURS` / `NAKARA_BACKUP_KEEP` | `24` / `14` | Snapshot interval and number of scheduled snapshots kept |
| `NAKARA_AGENT_GH_TOKEN` | — | GitHub token for agent containers of every factory without its own; required by the docker runner unless each factory has one, see [Security](#security) |
| `NAKARA_AGENT_GH_TOKEN__<SLUG>` | — | One factory's own agent token, used instead of `NAKARA_AGENT_GH_TOKEN`. `<SLUG>` is the factory slug upper-cased with `-` as `_` (`client-app` → `NAKARA_AGENT_GH_TOKEN__CLIENT_APP`), see [Security](#security) |
| `NAKARA_FOREMAN_GH_TOKEN` | — | Read-only GitHub token for the foreman's container; unset, it uses its factory's agent token (warned in the UI and `/healthz`), see [Security](#security) |
| `NAKARA_ALLOW_HOST_FOREMAN` | unset | `1` lets a foreman whose runner has no sandbox run on the host, unsandboxed (warned in the UI and `/healthz`); otherwise its turn pauses the item |
| `NAKARA_ALLOW_PERSONAL_GH_TOKEN` | unset | `1` gives agent containers your own `gh auth token` when neither the factory's own token nor `NAKARA_AGENT_GH_TOKEN` is set (warned in the UI) |
| `NAKARA_SECRETS_FILE` | `$NAKARA_DATA_DIR/secrets.env` | Agent secrets as `NAME=value` lines, mode 600, see [Security](#security) |
| `NAKARA_LOG_LEVEL` | `info` | Least severe level of the JSON log, see [Monitoring](#monitoring) |

## Backup and restore

`$NAKARA_DATA_DIR/nakara.db` is the only copy of every work item, foreman
session, approval, cost and run. It runs in WAL mode, so **do not back it up
with `cp` while Nakara runs**: the copy can miss committed pages in
`nakara.db-wal` and be corrupt.

**On-host snapshots.** Nakara snapshots the database itself with SQLite's
`VACUUM INTO`, which writes a consistent copy while it keeps writing. It takes
one at startup when the newest snapshot is older than
`NAKARA_BACKUP_INTERVAL_HOURS` (default 24), then every interval, and stores
them in `NAKARA_BACKUP_DIR` (default `$NAKARA_DATA_DIR/backups`) as
`nakara-<UTC time>-<reason>.db`. Each snapshot passes
`PRAGMA integrity_check` before it is kept. Code that must not run without a
fresh copy calls `snapshot(db, { dir, keep, reason })` from `src/backup.ts`;
startup takes a `pre-migration-<version>` snapshot before it applies a
pending schema migration.
Only `scheduled` snapshots are pruned: after each snapshot Nakara deletes all
but the newest `NAKARA_BACKUP_KEEP` (default 14) of them. Snapshots taken for
a reason (`pre-restore`, `pre-migration-<version>`, `pre-delete-<slug>`) are never pruned, so a long
run of scheduled snapshots cannot push out the copy from before a bad restore
or migration; they stay until you delete them by hand.
`/healthz` reports the newest snapshot as `backup.at`, `backup.ageSeconds`
and `backup.stale`; the sidebar footer shows its age, and the shell warns once
it is older than twice the interval. Failed snapshots are logged
(`journalctl --user -u nakara`).

**Off-host copy.** Snapshots on the same disk do not survive losing the disk
or the VPS. Replicate the database continuously to object storage with
[Litestream](https://litestream.io) (S3, Cloudflare R2, Backblaze B2, …).
Litestream reads the WAL, so it works alongside Nakara without changes:

```yaml
# /etc/litestream.yml
dbs:
  - path: /home/<user>/.local/share/nakara/nakara.db
    replicas:
      - url: s3://<bucket>/nakara
```

Run it as a service (`litestream replicate`) with the bucket credentials in
its environment. To recover onto a new host, run
`litestream restore -o nakara.db s3://<bucket>/nakara`, then restore that
file with the steps below. Copying `NAKARA_BACKUP_DIR` off the host (for
example with `rsync` from a cron job) also works, at snapshot granularity.

**Restore.** Stop Nakara and Litestream first, then restore a snapshot:

```bash
systemctl --user stop nakara
sudo systemctl stop litestream                   # if you replicate with Litestream
npm run restore                                  # lists the snapshots
npm run restore -- ~/.local/share/nakara/backups/nakara-<time>-scheduled.db
systemctl --user start nakara
sudo systemctl start litestream
```

The restore first takes the lock on `nakara.lock` (see below): while
Nakara runs, it refuses with the PID that holds the lock, before it touches
any file. It also refuses while any other process has `nakara.db` open. It
keeps the lock until it has verified the result. It checks
the file's integrity and snapshots the current database as
`…-pre-restore.db`, so a restore can be undone. A current database that
cannot be read is moved aside as `nakara.db.pre-restore-<time>` (with its
WAL) instead. The restore then removes the old WAL, replaces `nakara.db` and
boots a `Store` on it to confirm that it opens and migrates. The backup age
and schedule ignore `pre-restore` copies.
It uses the same `NAKARA_*` environment as the server; with systemd, load
`~/.config/nakara/env` first. Whatever Nakara recorded after the snapshot is
not in the restored database.

**Schema migrations.** `PRAGMA user_version` is the schema version of
`nakara.db`. At startup Nakara applies the pending migrations from
`src/db/migrations/` in order, each in its own transaction that also bumps the
version, so a failed migration leaves the database as it was. A database from
before versioned migrations is brought to the baseline (version 1) first; it
refuses to start, without changing the database, when a table has columns or
indexes the baseline does not know.
Nakara refuses to start on a database from a newer Nakara; upgrade, or
restore a snapshot taken before the upgrade. `/healthz` reports the version as
`schemaVersion`.
Migration 005 (the factory registry) creates the first factory from the
definition in `NAKARA_DEFINITION_DIR`, named after its label
(`factory:Nakara` gives the factory **Nakara**, slug `nakara`), and assigns
every existing work item to it. It needs that definition to load: when it does
not, Nakara refuses to start with the loader's errors and the database stays
at version 4. `npm run restore` names the factory the same way when it restores
an older snapshot.

**One Nakara per data directory.** At startup Nakara takes an exclusive lock
on `$NAKARA_DATA_DIR/nakara.lock` and keeps it until it exits. A second
Nakara on the same data directory (`npm run dev:server` next to the systemd
unit, two units, a test pointed at the real data) refuses to start and names
the PID that holds the lock; so does `npm run restore`. The
kernel releases the lock when the process dies, `kill -9` included, so a crash
never blocks the next start. Each run records the instance that started it,
and startup recovery only interrupts runs of other, dead instances. The lock is
an OS file lock: keep the data directory on a local disk, not on a network
share.

## Monitoring

### Logs

Nakara writes one JSON object per line: warnings and errors to stderr, the
rest to stdout, so journald keeps both. Every line carries `time`, `level` and
`event`. Lines from the orchestrator also carry `item_id`, and `run_id` and
`agent` once a run exists, so you can follow one work item through its foreman
turns, agent runs, `gh` calls and GitHub mirroring:

```bash
journalctl --user -u nakara -o cat | jq -c 'select(.item_id == 12)'
journalctl --user -u nakara -o cat | jq -c 'select(.level == "error" or .level == "warn")'
```

Useful events: `run.started` (with `wait_s`), `run.finished` (with `status`,
`duration_s`, `cost_usd`, `error`), `item.paused`, `item.budget_reached`,
`action.applied` / `action.refused`, `github.mirror_failed`,
`pr_checks.read_failed`, `intake.poll_failed`, `telegram.send_failed` and
`backup.failed`. `NAKARA_LOG_LEVEL` (`debug`, `info`, `warn`, `error`) sets the
least severe level written.

Logs never hold prompts: fields such as `prompt` and `input` are logged by
length only. Credentials are redacted before a line is written. This covers
fields named like a credential (`token`, `authorization`, …), the values of
secret-looking environment variables (`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`NAKARA_TELEGRAM_BOT_TOKEN`, …), the web token, and anything shaped like a
GitHub, Anthropic or Telegram bot token.

### Metrics

`GET /metrics` serves the Prometheus text format. Like the rest of the web UI,
it needs the token, except from a loopback peer: `/healthz` and `/metrics` are
the only routes a loopback peer reads without it. Other peers must be in
`NAKARA_ALLOW` and present the token. Every other route needs the token as the
cookie set by `?token=` or as `Authorization: Bearer <token>`.

| Metric | Type | |
|---|---|---|
| `nakara_runs_total{agent,harness,status}` | counter | Ended foreman turns and agent runs; `status` is `succeeded`, `failed`, `cancelled`, `stopped` (by the operator) or `interrupted` (by a restart) |
| `nakara_run_duration_seconds{agent,harness}` | histogram | Wall-clock time from the start of a run to its end |
| `nakara_queue_depth{role}` | gauge | Queued agent runs (`role="agent"`) and work items waiting for a foreman turn (`role="foreman"`) |
| `nakara_run_wait_seconds{role}` | histogram | Time from queueing to start |
| `nakara_cost_usd_total{agent}` | counter | Spend reported by the harness |
| `nakara_items_over_budget_total` | counter | Times a work item's spend reached its budget |
| `nakara_intake_poll_errors_total{source}` | counter | Failed GitHub polls, Telegram polls or deliveries, and Slack connections or deliveries |
| `nakara_last_poll_timestamp{source}` | gauge | Unix time of the last completed GitHub and Telegram poll, or Slack envelope |

Counters and histograms live in memory and start at zero on every restart,
which `rate()` and `increase()` expect. Per-day and per-item spend stays in the
database and the UI.

A Prometheus on the same host scrapes over loopback and needs no token:

```yaml
scrape_configs:
  - job_name: nakara
    metrics_path: /metrics
    static_configs:
      - targets: ["127.0.0.1:7788"]
```

A remote scraper must reach Nakara from an address in `NAKARA_ALLOW` (for
example over Tailscale, with `NAKARA_HOST` set to the tailnet IP), and sends the
token as a Bearer token. Copy `$NAKARA_DATA_DIR/token` to the Prometheus host
and point `credentials_file` at that copy:

```yaml
scrape_configs:
  - job_name: nakara
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/nakara-token
    static_configs:
      - targets: ["<tailnet IP>:7788"]
```

### Alerts

Suggested Prometheus alerting rules. Tune the thresholds to your factory:

```yaml
groups:
  - name: nakara
    rules:
      # Work is waiting, but nothing started in 30 minutes.
      - alert: NakaraQueueStuck
        expr: |
          sum(nakara_queue_depth) > 0
          unless sum(increase(nakara_run_wait_seconds_count[30m])) > 0
        for: 10m
      # The GitHub poller (every NAKARA_POLL_SECONDS) or the Telegram bridge
      # (a 50 s long poll) stopped completing polls, or keeps failing.
      - alert: NakaraPollerDead
        expr: |
          time() - nakara_last_poll_timestamp > 600
          or increase(nakara_intake_poll_errors_total[30m]) > 10
        for: 5m
      # Spend per hour above a threshold, e.g. a loop burning budget.
      - alert: NakaraSpendHigh
        expr: sum(increase(nakara_cost_usd_total[1h])) > 20
      # More than 30% of runs failed in the last hour (with at least 5 runs).
      - alert: NakaraRunFailureRate
        expr: |
          sum(increase(nakara_runs_total{status="failed"}[1h]))
            / sum(increase(nakara_runs_total[1h])) > 0.3
          and sum(increase(nakara_runs_total[1h])) >= 5
```

To deliver these alerts to the Nakara Telegram chat, use an Alertmanager
`telegram_configs` receiver with the same bot token and chat id
(`bot_token_file` and `chat_id`).

## Access from outside the server

The web UI binds to loopback. Choose one of the following:

- **code-server proxy** (behind Cloudflare Access): set `NAKARA_BASE_PATH=/proxy/7788`
  and `NAKARA_PUBLIC_URL=https://code.example.com/proxy/7788`, then open
  `https://code.example.com/proxy/7788/?token=…` once. The proxy is a
  loopback peer, but loopback no longer skips the token: the first visit sets the
  cookie, which lasts a year and renews on every page visit, so links from Telegram
  or GitHub open signed in. The public URL's host must match the `Host` the proxy forwards.
  To skip the token on every device, set the `NAKARA_ACCESS_*` variables: whoever
  passes Cloudflare Access with an Operator email is signed in. The audience tag is
  the `kid` in the Access login redirect (`curl -sI https://<host>/`).
- **Tailscale**: set `NAKARA_HOST=<tailnet IP>` and `NAKARA_ALLOW=<your device IP>`, then
  open `http://<tailnet IP>:7788/?token=…`. The token is in `$NAKARA_DATA_DIR/token`.
- **A dedicated hostname** needs a reverse proxy or tunnel (for example a Cloudflare Tunnel ingress rule) in front of the loopback port.

A systemd user unit is in `deploy/nakara.service`.

### Deploy

`scripts/deploy.sh [ref]` (default `origin/main`) exports the commit from the
checkout in `~/workspace/nakara` into `~/.local/share/nakara/releases/<sha>`,
runs `npm ci` and `npm run build` there, switches the `current` symlink to it
and restarts the unit. The unit runs from `current` and never compiles. A
failed build, or a full disk, stops the deploy, and the running release keeps
serving.

**Rollback.** An older release refuses a database a newer one migrated. When
the releases share a schema version, rolling back is `ln -sfn <older release>
current` and a restart. Otherwise, undo the newer migrations first, from the
release that applied them (it knows how):

```bash
systemctl --user stop nakara
cd ~/.local/share/nakara/releases/current
npm run downgrade                       # shows this release's version and the reversible ones
npm run downgrade -- 8                  # the version the older release knows; snapshots first
ln -sfn ~/.local/share/nakara/releases/<older sha> ~/.local/share/nakara/releases/current
systemctl --user start nakara
```

A downgrade loses only what the undone migrations stored (for 009, the
recorded stage moves). A migration without a `down` refuses the downgrade;
then restore its `pre-migration-<version>` snapshot (see
[Backup and restore](#backup-and-restore)), which loses everything written since.

`NAKARA_SRC`, `NAKARA_RELEASES`, `NAKARA_RELEASES_KEEP` (older releases
kept, default 3) and `NAKARA_RESTART=0` (switch without a restart) adjust it.
The factory definition stays in the checkout (`NAKARA_DEFINITION_DIR` in the
unit), so edits from the UI survive a deploy; `git pull` the checkout to update
it.

### Telegram

Factory messages go to one Telegram chat. Spec approvals arrive with Approve / Request
changes buttons, and replying to a message answers its question or messages the item.
Any other text becomes a work item through the `telegram-request` automation.

1. Create a bot with @BotFather and put `NAKARA_TELEGRAM_BOT_TOKEN=…` in `~/.config/nakara/env`.
2. Restart Nakara and send the bot any message. The log prints
   `message from chat <id>` (`journalctl --user -u nakara`).
3. Add `NAKARA_TELEGRAM_CHAT_ID=<id>` and restart. Every other chat is ignored.

### Slack

A listed member mentions the bot in a channel (or sends it a direct message) to create a
work item; a leading `@handle` picks the factory, like Telegram. The request's thread is
bound to the item: status, questions, the spec with Approve / Request changes buttons and
the PR link are posted there, and every reply in it goes to that item (it answers an open
question or the requested changes) and never creates a second one. The binding is in the
database, so it survives a restart. Approval also stays in the Inbox; the buttons take the
same path. Slack text is the item's request, never the foreman's instructions. When the
implement agent leaves [proof](#evidence), its screenshots are posted in the thread too.

The bridge uses Socket Mode (an outbound WebSocket), so no inbound webhook is needed.

1. Create a Slack app with Socket Mode on. Give it an app-level token with
   `connections:write`, bot scopes `app_mentions:read`, `channels:history`,
   `groups:history`, `im:history`, `chat:write` and `files:write` (screenshots of
   proof; without it they are only on the PR), and subscribe to the bot events
   `app_mention`, `message.channels`, `message.groups` and `message.im`. Turn on
   Interactivity (no request URL is needed with Socket Mode). Install it and invite the
   bot to the channel.
2. Put `NAKARA_SLACK_BOT_TOKEN=xoxb-…` and `NAKARA_SLACK_APP_TOKEN=xapp-…` in the
   secret store (`NAKARA_SECRETS_FILE`), not in `~/.config/nakara/env`. Agents can never
   be given them: `NAKARA_` names are refused in a definition.
3. In each factory that takes Slack requests, list the member IDs it trusts in
   `automations/slack-request/automation.md` (`filter.members`, profile → ⋯ → Copy member
   ID) and set `enabled: true`. Messages, replies and button presses from anyone else are
   ignored and logged as `slack.unlisted_member`.
4. Restart Nakara. `NAKARA_SLACK_ENABLED=false` switches the bridge off.

### Evidence

The implement agent runs on the `docker-browser` runner (the agent image plus
`playwright-cli` and Chromium; build it after `nakara-agent` with
`docker build -t nakara-agent-browser -f deploy/agent-browser.Dockerfile deploy`). For a
user-facing change it runs the app, screenshots each acceptance criterion into
`.nakara-proof/` and names the criterion of each screenshot in
`.nakara-proof/proof.json` (see the `ui-verification` skill). The directory is excluded
from git in every clone. After the run Nakara copies the screenshots out of the
workspace, refusing links, paths outside the directory, other file types and files over
10 MB, and tells the foreman which criteria have proof. Once the item has a PR, Nakara
uploads them as GitHub attachments with the operator's `gh` login (on a private repository
only people with access can open them) and writes one PR comment, "Evidence", listing each
criterion with its screenshot; a later run's proof replaces its content. They are also
posted in the item's Slack thread.

## Definition format

See `factory/` and the [Warp schema](https://docs.warp.dev/factories/factory-as-code/).
What this version supports:

| | Supported | Not yet |
|---|---|---|
| `factory.yaml` | `repositories`, `alias`, `agentDefaults`, `secrets`, `mcpServers` (`command`/`url`, `{{NAME}}` substitution of declared secrets, `tools` as a Nakara extension) | `integrations`, `cloudProviders`, `selfImprovement` |
| `agents/*/agent.md` | all agent types, `harness` `claude`/`codex`/`qwen` (qwen is a Nakara extension), `fallback` (Nakara extension, also in `agentDefaults`; see [Harness fallback](#harness-fallback)), `model` shorthand (`opus`/`sonnet`/`haiku`, `auto`), `secrets`, `mcpServers`, `spawnableBy`, `idleTimeoutMinutes`, per-agent skills | codex for the foreman or with `mcpServers` |
| `automations/*` | `github/issue_labeled` (polling), `nakara/manual`, `telegram/message` (long polling, one trusted chat), `slack/message` (Socket Mode, `filter.members` required), `schedule/cron_fired` (5-field UTC cron or `@hourly`, `@daily`/`@midnight`, `@weekly`, `@monthly`; no month/day names; missed minutes are not caught up) | Linear/Jira, other GitHub events |
| `runners/*` | `setupCommands` once per clone; `linux.dockerImage` runs agents in a container (no image = host); `instanceShape` as container CPU/memory limits; `egress.allow` (Nakara extension) as the hosts containers may reach | macOS/Windows |
| `scorers/*`, `benchmarks/*` | parsed and validated | execution |

### Harness fallback

A subscription's usage limit or a rate limit makes a harness refuse runs until
it resets. Nakara recognises that only in the CLI's own limit signal (claude's
`rate_limit_event`, its 429 `rate_limit`/`usage_limit_reached` API-error
message and error result, whose text starts "You've hit your … limit"; an
"API Error: 429" text counts only when those error fields or a rejected
`rate_limit_event` of the same run confirm it, so an outside 429 such as
"API Error: 429 from GitHub" stays an ordinary failure;
codex's error event starting "You've hit your usage limit … try again at …"
or "exceeded retry limit, last status: 429"), never in tool output, MCP
errors, the agent's reply or stderr that quote such a text. The run then
ends as rate limited instead of failed. List the harnesses to move to, in
order, under `fallback` in `agentDefaults` or in an agent's frontmatter (an
agent's own list replaces the default one):

```yaml
# factory.yaml
agentDefaults:
  harness: { type: claude }
  fallback: [codex, qwen]

# agents/review/agent.md
fallback:
  - { type: codex, model: gpt-5 }
```

Each entry is a harness kind (`claude`, `codex`, `qwen`) or a kind with a
`model` (and `reasoningLevel`). Other kinds are refused, and so are the cases
the codex harness is refused for: a codex fallback for the foreman, or for an
agent with `mcpServers`. A runner whose egress lacks a fallback's model hosts
is a warning, as it is for `harness`.

- **A fresh dispatch moves on.** When a run with no session to resume is
  limited before it did any work, the same brief starts again on the next
  harness in the list. Each attempt is its own run with its own harness, so
  the budget and the run limit count it; the run page of the new run says
  which run it replaced and why, the limited run's error names the new run,
  and the item's timeline has a message for each move. The foreman hears only
  the report of the run that finishes. Its state line names the harness of
  each agent run in progress.
- **A session never moves.** A follow-up, a resumed run, a run that did some
  work before the limit, and the foreman's own turns stay on their harness: a
  session cannot move between CLIs. They wait instead.
- **Wait instead of failing.** With no harness left, the item pauses with an
  Inbox notice ("Waiting for a usage limit") that names the harness and its
  limit, every earlier harness the brief hit a limit on, and when it resumes.
  Nakara holds its queued runs and foreman turns, and resumes it on its own
  once the earliest reset time the CLIs gave has passed, or, only when none of
  them gave one, after a fixed wait of 60 minutes (`LIMIT_WAIT_MS` in
  `src/orchestrator/limit-wait.ts`). A harness still limited then waits
  again. More limits while the item waits (other agents' runs) join the same
  wait without a second notification. A fresh brief resumes on the agent's own
  harness, and can move down the list again; a session continues where it
  stopped. A message to the item, or Retry, resumes it at once.
- **Without `fallback`** nothing changes except that a limited run pauses the
  item and resumes it this way, instead of failing it.

The wait is kept in the `kv` table (`limit-wait:<item>`, and
`fallback-of:<run>` for a moved run), so it survives a restart.

### Giving the foreman tools

The foreman reads the outside world through MCP servers in its `agent.md`.
Each server lists the tools the foreman may call; it gets those, never the
whole server, and its prompt names them. Keep them to reads: changes go through
Nakara's own tools or an agent the foreman dispatches. A read-only Linear:

```yaml
---
agentType: FOREMAN
secrets: [LINEAR_API_KEY]
mcpServers:
  linear:
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: "Bearer {{LINEAR_API_KEY}}"
    tools: [get_issue, list_issues, list_comments]
---
```

Put `LINEAR_API_KEY=...` in `NAKARA_SECRETS_FILE` (default
`$NAKARA_DATA_DIR/secrets.env`, mode 600), check the files with
`npm run validate -- factory`, and reload. The reload adds reach, so it waits
for your approval on the Definition page. Every call shows on the run page and
in the log as `tool.called`.

## Security

The web UI and API serve only you, the operator. Every request, loopback
included, needs the token (cookie or Bearer), except `GET /healthz` and
`GET /metrics` from a loopback peer. A request whose `Host` header is not
`NAKARA_HOST`, a loopback name on `NAKARA_PORT`, the `NAKARA_PUBLIC_URL` host
or listed in `NAKARA_ALLOWED_HOSTS` is refused first (so a web page cannot reach
the API through DNS rebinding while an SSH tunnel is open), and `x-forwarded-host`
is never trusted. Responses carry a Content-Security-Policy with
`frame-ancestors 'none'`. Over an SSH tunnel to `127.0.0.1:7788`, open
`http://127.0.0.1:7788/?token=…` once to set the cookie.

Agents run with `--permission-mode bypassPermissions`. Where they run depends on
the agent's runner:

- **`docker`** (default): one throwaway container per turn, as your uid. It sees
  only the item directory (`work/item-N`) read-write and the repository caches
  read-only, not your home, `~/.ssh` or other projects. Each work item has its
  own clone of every repository, with its own `.git`; its objects come from a
  private cache (`repos/<owner>/<name>.git`) that only Nakara's own fetch
  writes, so a new item costs little disk. Nakara treats everything an agent
  can write as hostile: it never runs git, a hook or a harness in an item's
  clone (diffs are read through a separate repository with an empty config),
  removes a workspace with a plain delete, and keeps its own files (prompts,
  logs, recorded foreman actions, MCP config, diffs) in `work/item-N.nakara`,
  outside every agent mount, written without following symlinks. Upgrading
  from the older layout (shared worktrees, `work/item-N/.nakara`) needs no
  step: at startup the old caches move to `repos.old` and fresh ones are
  cloned, and each item's worktrees become clones on the same branch with
  their commits and uncommitted changes; an item that cannot be migrated is
  paused with the reason. Only each worktree's checked-out branch is carried:
  other local branches, the stash and staging stay in `repos.old`, which
  Nakara never deletes (it logs a warning at each start). Delete it yourself
  once nothing there is needed. Build the image once:
  `docker build -t nakara-agent -f deploy/agent.Dockerfile deploy`.
  The container gets `GH_TOKEN` from its factory's own token,
  `NAKARA_AGENT_GH_TOKEN__<SLUG>`, when set, else from the shared
  `NAKARA_AGENT_GH_TOKEN`; without either, docker agent runs fail. Make it a
  fine-grained token with access to the factory repositories only and these
  repository permissions: Contents, Pull requests and Issues read/write
  (Metadata read is implied). Do not grant Administration or Workflows.
  A fine-grained token has exactly one resource owner (your account or one
  organization), so one token cannot cover factories whose repositories live
  under different owners: give each such factory its own token, named after its
  slug upper-cased with every character other than a letter or digit as `_`
  (factory `client-app` → `NAKARA_AGENT_GH_TOKEN__CLIENT_APP`). Slugs are
  lower-case letters, digits and `-`, so two factories never share a
  variable. An organization appears as a resource owner only once it allows
  fine-grained personal access tokens (organization settings, Personal access
  tokens). Keep these tokens in `~/.config/nakara/env` (mode 600) like the
  shared one; they never go in the definition or the database, and the UI,
  the API, `/healthz` and the log show only which source a factory uses
  (own, shared, personal), never a value. The Setup page, the definition
  page and `/healthz` name each factory's source and, after each repository
  check (every 10 minutes), warn when that token cannot push to one of the
  factory's repositories. The New factory wizard checks the repositories with
  the token the factory will get. Nakara marks a factory's pull requests ready
  and mirrors its updates on issues with the same token (with neither an own
  nor a shared token, with your gh login); it reads checks and PR state with
  your gh login, since the agent token has no Checks or Commit statuses
  permission. It reads the reviews and comments on the pull requests of a
  factory's work items, the login its tokens act as, and each commenter's
  repository permission with that factory's agent token: Pull requests and
  Issues read and Metadata read, which the permissions above already grant.
  The `gh` on an agent's and the foreman's PATH is Nakara's guard
  (`run-<id>.gh` beside the run's log), which refuses a comment, review or API
  body that starts with `/nakara` and runs the real `gh` otherwise. For
  `gh api graphql` it decodes every string in the query as GitHub does
  (escapes, `\u` escapes, block strings) and checks every variable, and it
  refuses a query whose strings it cannot decode; in a
  container it runs with the image's `node`. It guards `gh` only: an agent
  that posts through another client (`curl` with `GH_TOKEN`, the real `gh`
  by its full path, or a GitHub MCP server in its definition) is not stopped,
  which is one more reason to give agents a token of a separate account (see
  [Human PR feedback](#how-it-works)). To hand agents your own `gh auth token`
  instead, which reaches every repo you can, set
  `NAKARA_ALLOW_PERSONAL_GH_TOKEN=1`; it applies to factories with neither
  their own nor the shared token, and the definition page and `/healthz` then
  warn. The container also gets your git
  identity, and for the claude harness `CLAUDE_CODE_OAUTH_TOKEN` from Nakara's
  environment (create it with `claude setup-token`; put it in
  `~/.config/nakara/env`, mode 600). The foreman's container gets
  `GH_TOKEN` from `NAKARA_FOREMAN_GH_TOKEN` and holds no other GitHub token:
  make it a fine-grained token on the factory repositories with read-only
  Contents, Pull requests, Issues, Checks and Commit statuses (what its `gh issue
  view/list` and `gh pr view/diff/checks/list` need), so an injected foreman
  cannot change anything on GitHub. Unset, the foreman uses its factory's
  agent token and the definition page and `/healthz` warn.
  Network: containers run on an internal Docker network with no route out.
  Their only exit is a proxy container (`nakara-egress-*-proxy`, started from
  the runner image with `node`) that forwards to the hosts in the runner's
  `egress.allow` (HTTPS on port 443, plain HTTP on 80) and refuses the rest.
  Entries are host names or `*.domain.tld` for subdomains; `*`, `*.com`,
  schemes, ports and paths are rejected. Without `egress`, the allowlist is the
  Anthropic API, GitHub and the npm registry. Add your model gateway for codex
  or qwen, and any other package registry your setup commands use.
  Each harness needs its model's hosts in the egress of every runner it runs on:

  | Harness | Hosts in `egress.allow` |
  | --- | --- |
  | `claude` | `api.anthropic.com` (and `statsig.anthropic.com` for its telemetry, in the default list) |
  | `codex` | `chatgpt.com` (the model, with the ChatGPT login Nakara uses) and `auth.openai.com` (refreshes that login) |
  | `qwen` | the host of the gateway your `NAKARA_QWEN_BIN` wrapper sets in `ANTHROPIC_BASE_URL` |

  An agent whose runner's egress lacks its harness's hosts is a definition
  warning, on the Definition page, in the New factory wizard's preview and in
  `/healthz` ("agent "review" uses codex but runner "linux-standard" egress does
  not allow chatgpt.com, auth.openai.com ..."). The scaffolder copies a
  template's runners and harnesses as they are, so a template whose agents use
  codex on a runner with the default egress shows this warning until you add
  the hosts or pick claude for those agents (qwen's gateway is not known to
  Nakara, so it is not checked). A run whose harness still gets its model host
  refused by the egress proxy fails fast: after three refusals of that host, or
  a minute after one that the model never answers past, the run fails with an
  error naming the host and the runner's egress list, instead of retrying until
  the idle timeout. A changed
  allowlist or image gets a new network and proxy; the old ones stay. Remove
  them while no agent runs with
  `docker rm -f $(docker ps -aq --filter label=nakara.egress)` and
  `docker network prune --filter label=nakara.egress`.
  Docker v26 or later is required: older versions can forward DNS from
  internal networks, so Nakara refuses to start agent containers on them.
  All work items on a runner share its agent network, so one item's container
  can reach another's while both run. Nakara has one operator and the items
  come from the same repositories, so this is accepted.
- **`local`**: in the item's clone on the host, **as your user**. Not a sandbox.
  The harness, its MCP servers and setup commands do not inherit Nakara's
  environment: they get `PATH`, `HOME`, locale, proxy and CA variables, and
  only their own harness's credential (`CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_API_KEY` for claude, `CLAUDE_QWEN_*` for qwen, `OPENAI_API_KEY`
  for codex). `gh` and `git` use your login and config from `HOME`.

The **codex** harness uses its own login in `NAKARA_CODEX_HOME`
(default `~/.config/nakara/codex`; run
`mkdir -m 700 -p ~/.config/nakara/codex` and
`CODEX_HOME=~/.config/nakara/codex codex login --device-auth` once). Each
codex run gets its own fresh home in `<NAKARA_CODEX_HOME>.runs/`, holding
Nakara's execpolicy rules and the work item's earlier sessions (kept in the
item's `.nakara` directory, so follow-ups resume). When the run ends its
sessions are kept and the home is removed: anything else the agent wrote
there, such as `config.toml` or `AGENTS.md`, never reaches a later run. Only
`auth.json` is shared: it links to the login above (containers mount that one
file), because codex rotates the refresh token and runs holding separate
copies would end each other's login. In a container codex runs without its own sandbox; on the
local runner it uses `workspace-write` with network access. Execpolicy rules
forbid `gh pr merge`, `gh repo delete` and force pushes; the reviewer's
read-only restriction is not enforced for codex. Cost shows as $0 (ChatGPT plan).

The foreman runs in a container like every other agent, on its own runner's
image and egress allow list (ADR 0003). It sees the item's clones and the
definition read-only; the only thing it can write is its turn directory
(`item-<id>.nakara/foreman-<n>.turn`, where the nakara MCP server appends the
actions Nakara then re-checks against Policy) and its own home. It gets the
same GitHub and Claude tokens as agents. If its runner has no `dockerImage`, or
Docker or a token is missing, the turn pauses the item with the reason instead
of falling back to the host; `NAKARA_ALLOW_HOST_FOREMAN=1` runs it on the host
as before, unsandboxed, with a warning in the UI and `/healthz`. A foreman
session from a host run cannot be resumed inside the container, so the first
containerised turn starts a new one. Other guardrails:

- `gh pr merge` and force-pushes are on the disallow list for every run,
- reviewers cannot edit, commit, push or post,
- the foreman has an allowlist (the nakara MCP tools, plus read-only file and `gh` commands; no `git`, which would read config an agent could have written),
- each MCP server the foreman uses must list the tools it may call (`tools: [get_issue, list_issues]`,
  a Nakara extension); the foreman gets `mcp__<server>__<tool>` for those only, never the whole
  server. A server without `tools` is a definition error, and a tool named like a change
  (`create`, `update`, `delete`, `post`, `send`, `write`, `merge`, `close`) is a warning on the
  definition page. Agents run with `bypassPermissions`, which an allowlist cannot narrow, so on an
  agent's server `tools` limits nothing: give an agent only servers it may use in full,
- your personal MCP servers are never loaded (`--strict-mcp-config`).
- every call of an external MCP tool, by the foreman or an agent, is logged as
  `tool.called` (item, run, agent and tool name; never the arguments), and the run page lists
  the tools the run called with their counts. Calls of Nakara's own `mcp__nakara__*` tools are
  its actions and are not listed.

An agent's reach comes from the definition, never from its instructions
([ADR 0005](docs/adr/0005-reach-comes-from-configuration.md)). An MCP server
gets a credential only as `{{NAME}}` in its arguments, env, URL or headers,
and only when `NAME` is in the agent's secrets: the factory's `secrets` plus
the agent's own `secrets`, or `agentDefaults.secrets` when it declares none.
A reference to an undeclared name is a definition error on its line. The values
come from `NAKARA_SECRETS_FILE`, never from Nakara's environment, and names
of Nakara's own configuration (`NAKARA_*`, `CLAUDE_*`, `ANTHROPIC_*`,
`OPENAI_*`, `CODEX_*`, `GH_TOKEN`, `GITHUB_TOKEN`) are refused. Nakara does
not start when the file is open to group or others (`chmod 600` it), and a run
whose declared secret is missing from the file fails before its harness starts,
naming it. The file is read at each run, so an edit needs no restart. Secret
values are redacted from Nakara's log; the resolved MCP config holding them is
written to the item's `.nakara` directory, outside every agent mount.

A reload that widens what agents can reach waits for you. Nakara keeps, per
factory, the reach it last applied: for each agent its MCP servers' commands,
URLs, header and env names and `tools`, its secret names, and whether it runs
on the host; for each runner in use its container image and egress hosts. When a reload
(the Reload button, a settings save, a definition edit) adds any of those, the
previous definition keeps running and the Definition page lists what the files
add, with Approve and Reject. Approve applies exactly what was listed; Reject
keeps the old definition until the files change or you reload again. The first
load of a factory and changes that only narrow reach apply at once. Each
applied definition is copied to `$NAKARA_DATA_DIR/applied/`, so a restart with
an approval waiting runs that copy until you decide.

An MCP `url` server's host must be in the egress allow list of the agent's
runner, or the definition has an error naming the host: the container could not
reach it anyway. An agent on a runner without a `dockerImage` gets a warning
instead, since nothing limits what it reaches. The same check applies to the
foreman's servers, which run inside its container. A `command` server for a
foreman whose runner has no `dockerImage` is a definition error unless you set
`NAKARA_ALLOW_HOST_FOREMAN=1` to accept that it runs on the host unsandboxed.

These guardrails are CLI flags; a token with Contents write can still merge or
force-push through the REST API. The real control is branch protection on
GitHub: require a pull request with an approving review and block force pushes
on every factory repository's default branch, for administrators too (classic
protection: "Do not allow bypassing the above settings"). The repository check
warns on the definition page and in `/healthz` (`warnings`) when it cannot
confirm that. Classic protection is only readable with Administration read, so
with the agent token alone it says it could not verify; a ruleset is readable
without it. Ruleset bypass actors are not visible to the check: keep the agent
token's owner and any app that issues it off the bypass list.
Treat issue text from other people as untrusted input: anyone who can label an
issue can steer an agent.

## License

MIT. Agent prompts in `factory/agents/` are adapted from
`warpdotdev/warp-factory-examples` (MIT, `factory/LICENSE.warp-examples`).
