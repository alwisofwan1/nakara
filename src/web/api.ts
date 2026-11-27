import { open } from "node:fs/promises";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { validator } from "hono/validator";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { ChangeEvent } from "../db.ts";
import {
  hasSpecAgent,
  type LoadResult,
  type Problem,
} from "../definition/load.ts";
import type { Factory } from "../orchestrator/factory.ts";
import type { FactoryRegistry } from "../orchestrator/registry.ts";
import { isGitTracked, readFactoryFile } from "../definition/write.ts";
import { ModelCatalog } from "../harness/models.ts";
import {
  agentDeleteInput,
  agentEditInput,
  newAgentInput,
  readAgent,
  readAgents,
} from "./agents.ts";
import {
  automationDeleteInput,
  automationEditInput,
  cronPreview,
  cronPreviewInput,
  newAutomationInput,
  readAutomations,
  readIntake,
} from "./automations.ts";
import {
  type CheckResultDto,
  checkResultDto,
  definitionFiles,
  problemDto,
  readDefinition,
} from "./definition.ts";
import {
  createNewWork,
  DEFAULT_REQUESTER,
  type FetchIssue,
  fetchGithubIssue,
  newWorkInput,
  readNewWorkOptions,
} from "./newWork.ts";
import { LiveDiffs, readRunDiff } from "./run-diff.ts";
import { readRun, readRuns, runsQuery, systemPromptPath } from "./runs.ts";
import { readItem } from "./item-detail.ts";
import {
  approvalDecision,
  inboxQuery,
  lessonDecision,
  readInbox,
} from "./inbox.ts";
import { readSetup, repositoriesOf, verifyGithubToken } from "./setup.ts";
import { readBlueprint } from "./blueprint.ts";
import { readActivity } from "./items.ts";
import {
  type FetchPullRequest,
  fetchGithubPullRequest,
  pullRequestDto,
} from "./pull-request.ts";
import {
  factoryFileInput,
  limitsInput,
  moveInput,
  pauseState,
  readFactories,
  readFactorySettings,
  renameInput,
} from "./factories.ts";
import { definitionHistory } from "../definition/history.ts";
import { FactorySettings } from "../orchestrator/settings.ts";
import { readStatus } from "./status.ts";
import {
  cloneWarpExamples,
  readTemplate,
  warpExamples,
} from "../definition/scaffold.ts";
import { slugify } from "../definition/seed.ts";
import { FactoryCreation } from "../orchestrator/creation.ts";
import { mergePullRequest } from "../orchestrator/operator-merge.ts";
import { agentTokenOf } from "../runner/agent-token.ts";
import {
  ensureBareClone,
  internalFile,
  readInternal,
  run,
} from "../runner/workspace.ts";
import {
  accessQuery,
  agentToken,
  cachedClone,
  creationInput,
  creationRequest,
  ghCheckout,
  ghLogin,
  nameQuery,
  nameRefusal,
  owners,
  previewCreation,
  readCreation,
  readFactoryName,
  repoAccess,
  repoList,
  repoListArgs,
  reposQuery,
  runGh,
  templateQuery,
  type WizardDeps,
} from "./wizard.ts";

export type { ChangeEvent };
export type { RunStatus } from "../db.ts";
export type { AgentType, Stage } from "../domain/policy.ts";
export type {
  ActivityDto,
  Icon,
  ItemViewDto,
  LessonDto,
  OutcomesDto,
  StageGroup,
  Tone,
} from "./items.ts";
export type {
  ActionCardDto,
  ConversationEntryDto,
  ItemDetailDto,
} from "./item-detail.ts";
export type {
  CheckGroup,
  CheckState,
  GithubTokenKind,
  SetupCheckDto,
  SetupDto,
  VerifyDto,
  VerifyRepoDto,
} from "./setup.ts";
export type {
  InboxDto,
  InboxEntryDto,
  InboxEventDto,
  InboxKind,
  InboxLessonDto,
  InboxReachDto,
  LessonDecision,
} from "./inbox.ts";
export type {
  BlueprintDto,
  BlueprintStageDto,
  BlueprintTransitionDto,
} from "./blueprint.ts";
export type { FactoryDto, FactorySettingsDto } from "./factories.ts";
export type { PullRequestDto } from "./pull-request.ts";
export type { RepoDiffDto, RunDiffDto } from "./run-diff.ts";
export type { RunDetailDto, RunRowDto, RunsDto } from "./runs.ts";
export type {
  TemplateAgent,
  TemplateInfo,
} from "../definition/scaffold.ts";
export type {
  AgentTokenDto,
  CreationDto,
  CreationInput,
  CreationStepDto,
  FactoryNameDto,
  GhLoginDto,
  OwnerDto,
  PreviewDto,
  RepoAccessDto,
  RepoDto,
} from "./wizard.ts";
export const HEARTBEAT_MS = 15_000;
/** How often an open log stream checks the transcript file for new bytes. */
export const LOG_TAIL_MS = 500;
const LOG_CHUNK_BYTES = 256 * 1024;

const apiError = (code: string, message: string) => ({
  error: { code, message },
});
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const idParam = (name: string) =>
  validator("param", (value, c) => {
    const parsed = z.coerce.number().int().positive().safeParse(value.id);
    if (!parsed.success)
      return c.json(apiError("invalid", `${name} id must be a number`), 400);
    return { id: parsed.data };
  });
const runParam = idParam("Run");
const itemParam = idParam("Item");
const approvalParam = idParam("Approval");
const lessonParam = idParam("Lesson");

const nameParam = (kind: string) =>
  validator("param", (value, c) => {
    const name = z.string().min(1).max(255).safeParse(value.name);
    if (!name.success)
      return c.json(apiError("invalid_input", `Invalid ${kind} name`), 400);
    return { name: name.data };
  });
const agentParam = nameParam("agent");
const automationParam = nameParam("automation");

const jsonBody = <T extends z.ZodType>(schema: T, fallback: string) =>
  validator("json", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json(
        apiError(
          "invalid_input",
          issue
            ? `${issue.path.join(".") || "body"}: ${issue.message}`
            : fallback,
        ),
        400,
      );
    }
    return parsed.data as z.output<T>;
  });
const queryOf = <T extends z.ZodType>(schema: T) =>
  validator("query", (value, c) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      return c.json(
        apiError(
          "invalid_input",
          parsed.error.issues[0]?.message ?? "Invalid query",
        ),
        400,
      );
    return parsed.data as z.output<T>;
  });
const agentEditBody = jsonBody(agentEditInput, "Invalid agent settings");
const newAgentBody = jsonBody(newAgentInput, "Invalid agent");
const agentDeleteBody = jsonBody(agentDeleteInput, "Invalid request");
const automationEditBody = jsonBody(automationEditInput, "Invalid automation");
const newAutomationBody = jsonBody(newAutomationInput, "Invalid automation");
const automationDeleteBody = jsonBody(automationDeleteInput, "Invalid request");
const creationBody = jsonBody(creationInput, "Invalid factory");
const renameBody = jsonBody(renameInput, "Invalid factory settings");
const factoryFileBody = jsonBody(factoryFileInput, "Invalid factory settings");
const moveBody = jsonBody(moveInput, "Invalid folder");
const limitsBody = jsonBody(limitsInput, "Invalid limits");
const creationParam = validator("param", (value, c) => {
  const id = z.uuid().safeParse(value.id);
  if (!id.success)
    return c.json(apiError("invalid", "Creation id must be a UUID"), 400);
  return { id: id.data };
});

/** A refused definition write, with the loader's problems. */
const refusedWrite = (code: string, message: string, errors: Problem[]) => ({
  error: { code, message, problems: errors.map(problemDto) },
});
/** Creating or deleting an agent always changes the tree, so it always reloads. */
const reloaded = (reload: LoadResult | null): CheckResultDto =>
  reload ? checkResultDto(reload) : { ok: true, errors: [], warnings: [] };

const messageBody = (hint: string) =>
  validator("json", (value, c) => {
    const parsed = z
      .object({ message: z.string().trim().min(1).max(20_000) })
      .safeParse(value);
    if (!parsed.success) return c.json(apiError("invalid", hint), 400);
    return parsed.data;
  });
const followUpBody = messageBody("Write a follow-up message");

const decisionBody = validator("json", (value, c) => {
  const parsed = approvalDecision.safeParse(value);
  if (!parsed.success)
    return c.json(
      apiError("invalid", parsed.error.issues[0]?.message ?? "Invalid input"),
      400,
    );
  return parsed.data;
});

/** Byte offset to resume a log from: the SSE Last-Event-ID, else ?offset=. */
const logOffset = (
  lastEventId: string | undefined,
  query: string | undefined,
) => {
  const parsed = z.coerce
    .number()
    .int()
    .nonnegative()
    .safeParse(lastEventId ?? query ?? 0);
  return parsed.success ? parsed.data : 0;
};

/**
 * Send the complete lines of `path` after `from` as events whose id is the byte
 * offset after them. A trailing partial line is held back until the run ends.
 */
async function sendLog(
  stream: SSEStreamingApi,
  path: string,
  from: number,
  final: boolean,
): Promise<number> {
  const file = await open(path).catch(() => null);
  if (!file) return from;
  try {
    const { size } = await file.stat();
    let position = from;
    let window = LOG_CHUNK_BYTES;
    while (position < size && !stream.aborted) {
      const bytes = Buffer.alloc(Math.min(window, size - position));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
      if (bytesRead === 0) break;
      let end = bytes.lastIndexOf(10, bytesRead - 1) + 1;
      if (end === 0) {
        // One line longer than the window: widen it until the newline or EOF.
        if (position + bytesRead < size) {
          window *= 2;
          continue;
        }
        if (!final) break;
        end = bytesRead;
      }
      await stream.writeSSE({
        data: JSON.stringify(bytes.subarray(0, end).toString("utf8")),
        id: String(position + end),
      });
      position += end;
      window = LOG_CHUNK_BYTES;
    }
    return position;
  } finally {
    await file.close();
  }
}

/**
 * The routes of one factory, under /api/f/<slug>/: its automations, agents,
 * definition, activity and New work. Each reads and edits only that
 * factory's orchestrator and definition.
 */
function createFactoryApi(
  registry: FactoryRegistry,
  fetchIssue: FetchIssue,
  settings: FactorySettings,
) {
  const store = registry.store;
  return (
    new Hono<{ Variables: { factory: Factory } }>()
      .use(async (c, next) => {
        const factory = registry.get(c.req.param("slug") ?? "");
        if (!factory)
          return c.json(apiError("not_found", "Factory not found"), 404);
        c.set("factory", factory);
        await next();
      })
      .get("/automations", (c) => {
        const input = z.object({}).strict().safeParse(c.req.query());
        if (!input.success)
          return c.json(
            {
              error: {
                code: "invalid_input",
                message: "No query parameters are supported",
              },
            },
            400,
          );
        return c.json(
          readAutomations(
            store,
            c.var.factory.definition?.automations ?? [],
            new Date(),
            c.var.factory.definition?.label,
          ),
        );
      })
      // Writes automations/<name>/automation.md only when the tree loads with it, then reloads.
      .post("/automations", newAutomationBody, async (c) => {
        const automation = c.req.valid("json");
        const result = await c.var.factory.createAutomation(automation);
        if (!result.ok && result.code === "conflict")
          return c.json(apiError("conflict", result.message), 409);
        if (!result.ok)
          return c.json(
            refusedWrite(
              "invalid_definition",
              "The new automation would make the definition invalid; nothing was saved",
              result.errors,
            ),
            422,
          );
        return c.json(
          { name: automation.name, ...reloaded(result.reload) },
          201,
        );
      })
      // The next fire time of the cron the drawer is editing.
      .get("/automations/cron-preview", queryOf(cronPreviewInput), (c) =>
        c.json(cronPreview(c.req.valid("query").cron, new Date())),
      )
      // Writes automation.md only when the edited tree loads and the page is not
      // stale, then reloads; an omitted field keeps its value.
      .put(
        "/automations/:name",
        automationParam,
        automationEditBody,
        async (c) => {
          const { name } = c.req.valid("param");
          const loaded = c.var.factory.definition;
          if (!loaded)
            return c.json(
              apiError("policy", "No valid factory definition is loaded."),
              409,
            );
          const automation = loaded.automations.find((a) => a.name === name);
          if (!automation)
            return c.json(apiError("not_found", "Automation not found"), 404);
          const { revision, ...edit } = c.req.valid("json");
          const result = await c.var.factory.saveAutomation(
            name,
            {
              enabled: edit.enabled ?? automation.frontmatter.enabled,
              instructions: edit.instructions ?? automation.instructions,
              displayName: edit.displayName,
              agent: edit.agent,
              trigger: edit.trigger,
            },
            revision,
          );
          if (!result.ok && result.code === "conflict")
            return c.json(apiError("conflict", result.message), 409);
          if (!result.ok)
            return c.json(
              refusedWrite(
                "invalid_definition",
                "The edit would make the definition invalid; nothing was saved",
                result.errors,
              ),
              422,
            );
          const check: CheckResultDto = result.reload
            ? checkResultDto(result.reload)
            : {
                ok: true,
                errors: [],
                warnings:
                  c.var.factory.definitionProblems.warnings.map(problemDto),
              };
          return c.json(
            { ...check, revision: result.revision ?? revision },
            200,
          );
        },
      )
      // Deletes the automation's folder only when the definition still loads
      // without it; the work items it created stay.
      .delete(
        "/automations/:name",
        automationParam,
        automationDeleteBody,
        async (c) => {
          const { name } = c.req.valid("param");
          if (
            !c.var.factory.definition?.automations.some((a) => a.name === name)
          )
            return c.json(apiError("not_found", "Automation not found"), 404);
          const result = await c.var.factory.deleteAutomation(
            name,
            c.req.valid("json").revision,
          );
          if (!result.ok && result.code !== "invalid")
            return c.json(apiError(result.code, result.message), 409);
          if (!result.ok)
            return c.json(
              refusedWrite(
                "policy",
                `${name} cannot be deleted: ${result.errors.map((e) => e.message).join("; ")}`,
                result.errors,
              ),
              409,
            );
          return c.json(reloaded(result.reload), 200);
        },
      )
      // Run now: a work item for a scheduled automation, as its schedule would create it.
      .post("/automations/:name/run", automationParam, (c) => {
        const result = c.var.factory.runAutomation(
          c.req.valid("param").name,
          DEFAULT_REQUESTER,
        );
        if (!result.ok)
          return result.code === "not_found"
            ? c.json(apiError("not_found", result.reason), 404)
            : c.json(apiError("policy", result.reason), 409);
        return c.json({ id: result.item.id, title: result.item.title }, 201);
      })
      .get("/agents", (c) =>
        c.json(readAgents(store, c.var.factory.definition)),
      )
      // Writes agents/<name>/agent.md only when the tree loads with it, then reloads.
      .post("/agents", newAgentBody, async (c) => {
        const agent = c.req.valid("json");
        const result = await c.var.factory.createAgent(agent);
        if (!result.ok && result.code === "conflict")
          return c.json(apiError("conflict", result.message), 409);
        if (!result.ok)
          return c.json(
            refusedWrite(
              "invalid_definition",
              "The new agent would make the definition invalid; nothing was saved",
              result.errors,
            ),
            422,
          );
        return c.json({ name: agent.name, ...reloaded(result.reload) }, 201);
      })
      .get("/agents/:name", agentParam, async (c) => {
        const agent = readAgent(
          store,
          c.var.factory.definition,
          c.req.valid("param").name,
          // A managed definition commits each save itself.
          c.var.factory.record?.definition_mode !== "managed" &&
            (await isGitTracked(c.var.factory.config.definitionDir)),
        );
        if (!agent)
          return c.json(apiError("not_found", "Agent not found"), 404);
        return c.json(agent, 200);
      })
      // Deletes the agent's folder only when the definition still loads without it.
      .delete("/agents/:name", agentParam, agentDeleteBody, async (c) => {
        const { name } = c.req.valid("param");
        if (!c.var.factory.definition?.agents.has(name))
          return c.json(apiError("not_found", "Agent not found"), 404);
        const result = await c.var.factory.deleteAgent(
          name,
          c.req.valid("json").revision,
        );
        if (!result.ok && result.code !== "invalid")
          return c.json(apiError(result.code, result.message), 409);
        if (!result.ok)
          return c.json(
            refusedWrite(
              "policy",
              `${name} cannot be deleted: ${result.errors.map((e) => e.message).join("; ")}`,
              result.errors,
            ),
            409,
          );
        return c.json(reloaded(result.reload), 200);
      })
      // Writes agent.md only when the edited tree loads and the form is not stale,
      // then reloads the definition.
      .put("/agents/:name", agentParam, agentEditBody, async (c) => {
        const { name } = c.req.valid("param");
        if (!c.var.factory.definition?.agents.has(name))
          return c.json(apiError("not_found", "Agent not found"), 404);
        const { revision, ...edit } = c.req.valid("json");
        const result = await c.var.factory.saveAgent(name, edit, revision);
        if (!result.ok && result.code === "conflict")
          return c.json(apiError("conflict", result.message), 409);
        if (!result.ok)
          return c.json(
            refusedWrite(
              "invalid_definition",
              "The edit would make the definition invalid; nothing was saved",
              result.errors,
            ),
            422,
          );
        // Nothing changed: the running definition stands as it is.
        if (!result.reload)
          return c.json(
            {
              ok: true,
              errors: [],
              warnings:
                c.var.factory.definitionProblems.warnings.map(problemDto),
            } satisfies CheckResultDto,
            200,
          );
        return c.json(checkResultDto(result.reload), 200);
      })
      .get("/definition", async (c) =>
        c.json(
          readDefinition(store, {
            dir: c.var.factory.config.definitionDir,
            definition: c.var.factory.definition,
            problems: c.var.factory.definitionProblems,
            pendingReach: c.var.factory.pendingReach(),
            files: await definitionFiles(c.var.factory.config.definitionDir),
            slug: c.var.factory.record?.slug,
            mode: c.var.factory.record?.definition_mode,
          }),
        ),
      )
      // Validate loads the files from disk and never touches the running definition.
      .post("/definition/validate", async (c) =>
        c.json(checkResultDto(await c.var.factory.validateDefinition())),
      )
      .post("/definition/reload", async (c) => {
        const result = await c.var.factory.reloadDefinition();
        if (result.ok) void c.var.factory.checkRepositories();
        return c.json(checkResultDto(result));
      })
      // The operator decides on a reload that widens what agents can reach.
      .post("/definition/reach/approve", async (c) => {
        const reload = c.var.factory.approveReach();
        if (!reload)
          return c.json(
            {
              error: {
                code: "not_found",
                message: "Nothing waits for approval.",
              },
            },
            404,
          );
        const result = await reload;
        if (result.ok) void c.var.factory.checkRepositories();
        return c.json(checkResultDto(result), 200);
      })
      .post("/definition/reach/reject", (c) =>
        c.var.factory.rejectReach()
          ? c.json({ ok: true }, 200)
          : c.json(
              {
                error: {
                  code: "not_found",
                  message: "Nothing waits for approval.",
                },
              },
              404,
            ),
      )
      .get("/items", (c) =>
        c.json(readActivity(store, c.var.factory.record?.id)),
      )
      .get("/blueprint", (c) =>
        c.json(readBlueprint(store, c.var.factory.record?.id)),
      )
      .get("/settings", async (c) => {
        const { factory } = c.var;
        const managed = factory.record?.definition_mode === "managed";
        const dto = readFactorySettings(
          store.repos,
          c.req.param("slug") ?? "",
          {
            repositories: (factory.definition?.factory.repositories ?? []).map(
              (r) => `${r.owner}/${r.name}`,
            ),
            label: factory.definition?.label ?? null,
            history: managed
              ? await definitionHistory(factory.config.definitionDir)
              : [],
            archiveDir:
              managed && factory.record
                ? settings.archiveDir(factory.record.slug)
                : null,
            backupDir: registry.config.backup.dir,
            specAgent: factory.definition
              ? hasSpecAgent(factory.definition)
              : null,
            factoryFile: await readFactoryFile(factory.config.definitionDir),
            intake: readIntake(
              factory.definition?.automations ?? [],
              factory.definition?.label,
            ),
          },
        );
        if (!dto)
          return c.json(apiError("not_found", "Factory not found"), 404);
        return c.json(dto, 200);
      })
      // Rename: the display name and avatar; the slug and every URL stay.
      .put("/settings", renameBody, (c) => {
        const result = settings.rename(c.var.factory, c.req.valid("json"));
        if (!result.ok) return c.json(apiError("policy", result.message), 409);
        return c.json({ slug: c.req.param("slug") ?? "" }, 200);
      })
      // Writes factory.yaml only when the edited tree loads and the form is not
      // stale, then reloads; an empty description removes the key.
      .put("/settings/definition", factoryFileBody, async (c) => {
        const { revision, description } = c.req.valid("json");
        const result = await c.var.factory.saveFactory(
          { description },
          revision,
        );
        if (!result.ok && result.code === "conflict")
          return c.json(apiError("conflict", result.message), 409);
        if (!result.ok)
          return c.json(
            refusedWrite(
              "invalid_definition",
              "The edit would make the definition invalid; nothing was saved",
              result.errors,
            ),
            422,
          );
        // Nothing changed: the running definition stands as it is.
        const check: CheckResultDto = result.reload
          ? checkResultDto(result.reload)
          : {
              ok: true,
              errors: [],
              warnings:
                c.var.factory.definitionProblems.warnings.map(problemDto),
            };
        return c.json({ ...check, revision: result.revision ?? revision }, 200);
      })
      // Budget, review, revision and run limits and the Spec rule for the
      // factory's new Work Items; items already created keep what they
      // copied (ADR-0006).
      .put("/settings/limits", limitsBody, (c) => {
        const id = c.var.factory.record?.id;
        if (id === undefined)
          return c.json(apiError("not_found", "Factory not found"), 404);
        store.repos.factorySettings.saveLimits(id, c.req.valid("json"));
        return c.json(store.repos.factorySettings.settings(id), 200);
      })
      // Pause: new Work Items wait in Intake and nothing new starts; running
      // work finishes. Resume starts the waiting work at once. Both idempotent.
      .post("/pause", (c) => {
        const pausedAt = c.var.factory.setPaused(true);
        if (pausedAt === undefined)
          return c.json(apiError("not_found", "Factory not found"), 404);
        return c.json(pauseState(pausedAt), 200);
      })
      .post("/resume", (c) => {
        const pausedAt = c.var.factory.setPaused(false);
        if (pausedAt === undefined)
          return c.json(apiError("not_found", "Factory not found"), 404);
        return c.json(pauseState(pausedAt), 200);
      })
      // Refused for the default factory and while it has active items or runs;
      // the database is snapshotted first.
      .delete("/", async (c) => {
        const result = await settings.delete(c.var.factory);
        if (!result.ok) return c.json(apiError("policy", result.message), 409);
        return c.json(
          { deleted: c.req.param("slug") ?? "", snapshot: result.snapshot },
          200,
        );
      })
      // Move a managed definition into a repository folder; it runs from there.
      .post("/definition/move", moveBody, async (c) => {
        const result = await settings.move(c.var.factory, c.req.valid("json"));
        if (!result.ok && result.code === "checkout")
          return c.json(apiError("github", result.message.slice(0, 1000)), 502);
        if (!result.ok)
          return c.json(
            refusedWrite("policy", result.message, result.problems ?? []),
            409,
          );
        return c.json({ dir: result.dir, archive: result.archive }, 200);
      })
      // Copy a repository definition into a Nakara-managed folder; it runs from there.
      .post("/definition/adopt", async (c) => {
        const result = await settings.adopt(c.var.factory);
        if (!result.ok)
          return c.json(
            refusedWrite("policy", result.message, result.problems ?? []),
            409,
          );
        return c.json(
          { dir: result.dir, history: result.history, note: result.note },
          200,
        );
      })
      .get("/new-work", (c) =>
        c.json(
          readNewWorkOptions(
            store,
            c.var.factory.definition,
            c.var.factory.record?.id,
          ),
        ),
      )
      .post(
        "/items",
        validator("json", (value, c) => {
          const parsed = newWorkInput.safeParse(value);
          if (!parsed.success)
            return c.json(
              {
                error: {
                  code: "invalid" as const,
                  message: parsed.error.issues[0]?.message ?? "Invalid input",
                },
              },
              400,
            );
          return parsed.data;
        }),
        async (c) => {
          const result = await createNewWork(
            c.var.factory,
            c.req.valid("json"),
            fetchIssue,
          );
          if (!result.ok) return c.json({ error: result.error }, result.status);
          return c.json({ id: result.item.id, title: result.item.title }, 201);
        },
      )
  );
}

/**
 * The JSON API: factory routes under /f/<slug>/, and the routes that span
 * factories (status, Inbox, Runs, and items, approvals and runs by their
 * global id, each acted on by the orchestrator of the item's factory).
 */
export function createApi(
  registry: FactoryRegistry,
  config: Config,
  fetchIssue: FetchIssue = fetchGithubIssue,
  fetchPullRequest: FetchPullRequest = fetchGithubPullRequest,
  wizard: WizardDeps = { gh: runGh, env: process.env },
  models = new ModelCatalog({
    claude: config.claudeBin,
    codex: config.codexBin,
  }),
) {
  const store = registry.store;
  /** The description in a factory's applied factory.yaml. */
  const descriptionOf = (slug: string) =>
    registry.get(slug)?.definition?.factory.description ?? null;
  /** The orchestrator of the item's factory. */
  const orchestrator = (itemId: number) =>
    registry.forItem(itemId) ?? registry.default;
  /** Lessons whose approval is being written, so a double submit writes them once. */
  const deciding = new Set<number>();
  /** A ?factory= filter: its id, null for none, undefined for an unknown slug. */
  const factoryFilter = (slug: string | undefined) =>
    slug === undefined ? null : registry.get(slug)?.record?.id;
  const scaffoldDeps = wizard.scaffold ?? {
    cloneWarpExamples: cachedClone(cloneWarpExamples),
  };
  const creation = new FactoryCreation(registry, config, {
    gh: (args) => wizard.gh(args),
    scaffold: scaffoldDeps,
    clone: wizard.clone ?? ensureBareClone,
    checkout: ghCheckout(wizard.gh),
    git: (args, cwd) => run("git", args, cwd),
  });
  const settings = new FactorySettings(registry, creation);
  const liveDiffs = new LiveDiffs();
  const api = new Hono()
    .route("/f/:slug", createFactoryApi(registry, fetchIssue, settings))
    .get("/status", (c) =>
      c.json(
        readStatus(store, {
          telegramConfigured: Boolean(
            config.telegram.token && config.telegram.chatId,
          ),
          concurrency: config.concurrency,
          factories: registry.factories.map((factory) => ({
            slug: factory.record?.slug ?? "",
            loaded: Boolean(factory.definition),
            errors: factory.definitionProblems.errors.length,
            repositories: factory.definition?.factory.repositories.length ?? 0,
          })),
          backup: config.backup,
        }),
      ),
    )
    // What Nakara needs to run, checked now; the Setup page.
    .get("/setup", async (c) => {
      const poll = store.getKv("github:lastPoll");
      return c.json(
        await readSetup({
          store,
          config,
          factories: registry.factories.map((factory) => ({
            slug: factory.record?.slug ?? "",
            definition: factory.definition,
            errors: factory.definitionProblems.errors.length,
          })),
          poll: poll ? JSON.parse(poll) : null,
        }),
      );
    })
    // Asks GitHub whether the agent or foreman token works and reaches the repositories.
    .post(
      "/setup/verify",
      jsonBody(
        z.object({ token: z.enum(["agent", "foreman"]) }),
        "Invalid token",
      ),
      async (c) =>
        c.json(
          await verifyGithubToken(
            c.req.valid("json").token,
            // The shared agent token serves only the factories without their own.
            repositoriesOf(
              registry.factories.flatMap((f) =>
                f.definition &&
                (c.req.valid("json").token === "foreman" ||
                  agentTokenOf(f.record?.slug).source === "shared")
                  ? [f.definition]
                  : [],
              ),
            ),
          ),
        ),
    )
    .get("/factories", (c) => c.json(readFactories(store.repos, descriptionOf)))
    // The models the harness CLI offers, asked again at most once an hour.
    .get("/models/:harness", async (c) => {
      const harness = c.req.param("harness");
      if (harness !== "claude" && harness !== "codex")
        return c.json(
          {
            error: {
              code: "not_found" as const,
              message: `${harness} has no model list`,
            },
          },
          404,
        );
      try {
        return c.json({
          models: await models.list(harness),
        });
      } catch (error) {
        return c.json(
          {
            error: {
              code: "unavailable" as const,
              message: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 500),
            },
          },
          502,
        );
      }
    })
    // The New factory wizard: what gh and the agent token can reach. Read only.
    .get("/wizard/github", async (c) => {
      const login = ghLogin(
        await wizard.gh(["auth", "status", "--hostname", "github.com"]),
      );
      return c.json(
        {
          login,
          owners: login.account
            ? owners(
                login.account,
                await wizard.gh([
                  "api",
                  "user/orgs",
                  "--paginate",
                  "--jq",
                  ".[].login",
                ]),
              )
            : [],
          agentToken: agentToken(wizard.env),
        },
        200,
      );
    })
    .get("/wizard/repos", queryOf(reposQuery), async (c) => {
      const { owner } = c.req.valid("query");
      const result = await wizard.gh(repoListArgs(owner));
      if (!result.ok)
        return c.json(
          apiError(
            "github",
            `Could not list the repositories of ${owner}: ${result.stderr.trim().slice(0, 300)}`,
          ),
          502,
        );
      const repos = repoList(result.stdout);
      if (!repos)
        return c.json(
          apiError(
            "github",
            `gh repo list ${owner} did not return a repository list`,
          ),
          502,
        );
      return c.json({ owner, repos }, 200);
    })
    .get("/wizard/access", queryOf(accessQuery), async (c) => {
      const { repos, slug } = c.req.valid("query");
      return c.json(await repoAccess(wizard, repos, slug));
    })
    .get("/wizard/name", queryOf(nameQuery), (c) =>
      c.json(readFactoryName(store.repos.factories, c.req.valid("query").name)),
    )
    .get("/wizard/examples", async (c) => {
      try {
        return c.json({ examples: await warpExamples(scaffoldDeps) }, 200);
      } catch (error) {
        return c.json(
          apiError(
            "github",
            `Could not list the Warp examples: ${errorMessage(error).slice(0, 300)}`,
          ),
          502,
        );
      }
    })
    // The agents and intake a template starts with; an import is read from disk.
    .get("/wizard/template", queryOf(templateQuery), async (c) => {
      try {
        return c.json(
          await readTemplate(c.req.valid("query"), scaffoldDeps),
          200,
        );
      } catch (error) {
        return c.json(
          apiError("template", errorMessage(error).slice(0, 500)),
          422,
        );
      }
    })
    // Review: the files Create would write, validated in memory.
    .post("/wizard/preview", creationBody, async (c) => {
      const request = creationRequest(c.req.valid("json"));
      return c.json(
        await previewCreation(
          store.repos.factories,
          registry,
          creation.definitionDir(
            slugify(request.choices.name),
            request.location,
          ),
          request,
          scaffoldDeps,
        ),
        200,
      );
    })
    // Create: accepted, then each step's progress is announced on /api/events.
    .post("/wizard/creations", creationBody, async (c) => {
      const input = c.req.valid("json");
      const refusal = nameRefusal(store.repos.factories, input);
      if (refusal) return c.json(apiError("policy", refusal), 409);
      const started = await creation.start(creationRequest(input));
      if (!started.ok) return c.json(apiError("policy", started.message), 409);
      return c.json(
        // biome-ignore lint/style/noNonNullAssertion: start() saved the job.
        readCreation(store, started.job.id)!,
        202,
      );
    })
    .get("/wizard/creations/:id", creationParam, (c) => {
      const dto = readCreation(store, c.req.valid("param").id);
      if (!dto) return c.json(apiError("not_found", "Creation not found"), 404);
      return c.json(dto, 200);
    })
    .post("/wizard/creations/:id/retry", creationParam, (c) => {
      const retried = creation.retry(c.req.valid("param").id);
      if (!retried.ok)
        return retried.code === "not_found"
          ? c.json(apiError("not_found", retried.message), 404)
          : c.json(apiError("policy", retried.message), 409);
      return c.json(
        // biome-ignore lint/style/noNonNullAssertion: retry() saved the job.
        readCreation(store, retried.job.id)!,
        202,
      );
    })
    .get("/items/:id", itemParam, (c) => {
      const dto = readItem(store, c.req.valid("param").id);
      if (!dto)
        return c.json(apiError("not_found", "Work item not found"), 404);
      return c.json(dto, 200);
    })
    .get("/items/:id/pr", itemParam, async (c) => {
      const item = store.item(c.req.valid("param").id);
      if (!item?.pr_url)
        return c.json(apiError("not_found", "No pull request yet"), 404);
      try {
        return c.json(
          pullRequestDto(item.pr_url, await fetchPullRequest(item.pr_url)),
          200,
        );
      } catch (error) {
        return c.json(
          apiError(
            "github",
            `Could not read the pull request: ${String(error).slice(0, 300)}`,
          ),
          502,
        );
      }
    })
    .post(
      "/items/:id/messages",
      itemParam,
      messageBody("Write a message"),
      (c) => {
        const { id } = c.req.valid("param");
        if (!store.item(id))
          return c.json(apiError("not_found", "Work item not found"), 404);
        try {
          orchestrator(id).sendMessage(id, c.req.valid("json").message);
        } catch (error) {
          return c.json(apiError("policy", errorMessage(error)), 409);
        }
        return c.json({ item: { id } }, 202);
      },
    )
    .post("/items/:id/cancel", itemParam, async (c) => {
      const { id } = c.req.valid("param");
      const item = store.item(id);
      if (!item)
        return c.json(apiError("not_found", "Work item not found"), 404);
      if (item.stage === "complete" || item.stage === "cancelled")
        return c.json(apiError("policy", "The work item is closed."), 409);
      await orchestrator(id).cancel(id);
      return c.json({ item: { id } }, 200);
    })
    .post("/items/:id/merge", itemParam, async (c) => {
      // The Operator's merge; agents can never merge (ADR-0006 rule 6).
      const { id } = c.req.valid("param");
      const result = await mergePullRequest(store, id);
      if (!result.ok)
        return result.code === "not_found"
          ? c.json(apiError("not_found", result.reason), 404)
          : c.json(apiError("policy", result.reason), 409);
      return c.json({ item: { id }, method: result.method }, 200);
    })
    .post("/items/:id/retry", itemParam, (c) => {
      const { id } = c.req.valid("param");
      const result = orchestrator(id).retry(id);
      if (!result.ok)
        return result.code === "not_found"
          ? c.json(apiError("not_found", result.reason), 404)
          : c.json(apiError("policy", result.reason), 409);
      return c.json({ run: { id: result.run.id } }, 202);
    })
    .post("/items/:id/raise-budget", itemParam, (c) => {
      const { id } = c.req.valid("param");
      const result = orchestrator(id).raiseBudget(id);
      if (!result.ok)
        return result.code === "not_found"
          ? c.json(apiError("not_found", result.reason), 404)
          : c.json(apiError("policy", result.reason), 409);
      return c.json(
        { item: { id: result.item.id, budgetUsd: result.item.budget_usd } },
        200,
      );
    })
    .post("/items/:id/raise-run-limit", itemParam, (c) => {
      const { id } = c.req.valid("param");
      const result = orchestrator(id).raiseRunLimit(id);
      if (!result.ok)
        return result.code === "not_found"
          ? c.json(apiError("not_found", result.reason), 404)
          : c.json(apiError("policy", result.reason), 409);
      return c.json(
        { item: { id: result.item.id, maxRuns: result.item.max_runs } },
        200,
      );
    })
    .get(
      "/inbox",
      validator("query", (value, c) => {
        const query = inboxQuery.safeParse(value);
        if (!query.success)
          return c.json(
            apiError(
              "invalid_input",
              query.error.issues[0]?.message ?? "Invalid query",
            ),
            400,
          );
        return query.data;
      }),
      (c) => {
        const factoryId = factoryFilter(c.req.valid("query").factory);
        if (factoryId === undefined)
          return c.json(apiError("not_found", "Factory not found"), 404);
        return c.json(readInbox(store, { factoryId }), 200);
      },
    )
    .post("/approvals/:id", approvalParam, decisionBody, (c) => {
      const { id } = c.req.valid("param");
      const { decision, answer } = c.req.valid("json");
      const approval = store.approval(id);
      if (!approval)
        return c.json(apiError("not_found", "Approval not found"), 404);
      if ((approval.kind === "question") !== (decision === "answer"))
        return c.json(
          apiError(
            "invalid",
            approval.kind === "question"
              ? "Answer the question"
              : "Approve the spec or request changes",
          ),
          400,
        );
      try {
        orchestrator(approval.item_id).answerApproval(id, {
          approved: decision === "approve",
          answer,
        });
      } catch (error) {
        return c.json(
          apiError(
            "policy",
            error instanceof Error ? error.message : String(error),
          ),
          409,
        );
      }
      return c.json({ itemId: approval.item_id }, 200);
    })
    // Approving writes the lines to the item's factory's learnings skill first;
    // the proposal is marked approved only once they are on disk.
    .post(
      "/lessons/:id",
      lessonParam,
      validator("json", (value, c) => {
        const parsed = lessonDecision.safeParse(value);
        if (!parsed.success)
          return c.json(
            apiError(
              "invalid",
              parsed.error.issues[0]?.message ?? "Invalid input",
            ),
            400,
          );
        return parsed.data;
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const decision = c.req.valid("json");
        const lesson = store.learning(id);
        if (!lesson || lesson.status !== "pending" || deciding.has(id))
          return c.json(
            apiError("not_found", "Nothing waits for approval."),
            404,
          );
        if (decision.decision === "reject") {
          store.resolveLearning(id, "rejected", { reason: decision.reason });
          return c.json({ ok: true }, 200);
        }
        const lines = decision.lines ?? (JSON.parse(lesson.lines) as string[]);
        deciding.add(id);
        try {
          const result = await orchestrator(lesson.item_id).saveLearning(lines);
          if (!result.ok)
            return c.json(
              apiError(
                result.code === "conflict" ? "conflict" : "invalid",
                result.code === "conflict"
                  ? result.message
                  : (result.errors[0]?.message ?? "The lesson was refused"),
              ),
              result.code === "conflict" ? 409 : 422,
            );
          store.resolveLearning(id, "approved", {
            lines: lines.map((line) => line.trim()),
          });
          return c.json({ ok: true }, 200);
        } finally {
          deciding.delete(id);
        }
      },
    )
    .get(
      "/runs",
      validator("query", (value, c) => {
        const query = runsQuery.safeParse(value);
        if (!query.success)
          return c.json(
            {
              error: {
                code: "invalid_input",
                message: query.error.issues[0]?.message ?? "Invalid query",
              },
            },
            400,
          );
        return query.data;
      }),
      (c) => {
        const { factory, ...query } = c.req.valid("query");
        const factoryId = factoryFilter(factory);
        if (factoryId === undefined)
          return c.json(apiError("not_found", "Factory not found"), 404);
        return c.json(readRuns(store, { ...query, factoryId }), 200);
      },
    )
    .get("/events", (c) => {
      c.header("X-Accel-Buffering", "no");
      c.header("Cache-Control", "no-cache, no-transform");
      return streamSSE(c, async (stream) => {
        let finish = () => {};
        const closed = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const send = (event: ChangeEvent) => {
          void stream.writeSSE({ data: JSON.stringify(event) }).catch(finish);
        };
        const heartbeat = setInterval(() => {
          void stream.write(": heartbeat\n\n").catch(finish);
        }, HEARTBEAT_MS);
        store.changes.on("change", send);
        stream.onAbort(finish);
        try {
          // Revalidate on every connection, including reconnects after missed changes.
          send({ type: "status", id: "global" });
          send({ type: "items", id: "global" });
          send({ type: "runs", id: "global" });
          await closed;
        } finally {
          clearInterval(heartbeat);
          store.changes.off("change", send);
        }
      });
    })
    .get("/runs/:id", runParam, async (c) => {
      const { id } = c.req.valid("param");
      const run = store.runById(id);
      if (!run) return c.json(apiError("not_found", "Run not found"), 404);
      const promptPath = systemPromptPath(run);
      const systemPrompt = promptPath
        ? await readInternal(config.workDir, run.item_id, promptPath)
        : null;
      const definition = orchestrator(run.item_id).definition;
      const dto = readRun(store, id, {
        workDir: config.workDir,
        systemPrompt,
        agent: (name) => {
          const agent = definition?.agents.get(name);
          if (!agent) return undefined;
          const image = agent.runner
            ? definition?.runners.get(agent.runner)?.platform?.linux
                ?.dockerImage
            : undefined;
          return {
            type: agent.type,
            runner: [agent.runner ?? "local", image]
              .filter(Boolean)
              .join(" · "),
            docker: Boolean(image),
          };
        },
      });
      if (!dto) return c.json(apiError("not_found", "Run not found"), 404);
      return c.json(dto, 200);
    })
    .post("/runs/:id/follow-up", runParam, followUpBody, (c) => {
      const { id } = c.req.valid("param");
      // Factory.followUp passes the run to its item's factory.
      const result = registry.default.followUp(id, c.req.valid("json").message);
      if (!result.ok)
        return result.code === "not_found"
          ? c.json(apiError("not_found", result.reason), 404)
          : c.json(apiError("policy", result.reason), 409);
      return c.json({ run: { id: result.run.id } }, 202);
    })
    // Accepted, not done: the run shows as cancelled once its process has exited.
    .post("/runs/:id/stop", runParam, (c) => {
      const { id } = c.req.valid("param");
      // Factory.stopRun passes the run to its item's factory.
      const result = registry.default.stopRun(id);
      if (!result.ok)
        return result.code === "not_found"
          ? c.json(apiError("not_found", result.reason), 404)
          : c.json(apiError("policy", result.reason), 409);
      return c.json({ run: { id: result.run.id } }, 202);
    })
    .get("/runs/:id/diff", runParam, async (c) => {
      const run = store.runById(c.req.valid("param").id);
      if (!run) return c.json(apiError("not_found", "Run not found"), 404);
      return c.json(await readRunDiff(run, config, { live: liveDiffs }), 200);
    })
    .get("/runs/:id/log", runParam, (c) => {
      const { id } = c.req.valid("param");
      if (!store.runById(id))
        return c.json(apiError("not_found", "Run not found"), 404);
      c.header("X-Accel-Buffering", "no");
      c.header("Cache-Control", "no-cache, no-transform");
      let position = logOffset(
        c.req.header("last-event-id"),
        c.req.query("offset"),
      );
      return streamSSE(c, async (stream) => {
        let wake = () => {};
        const onChange = (event: ChangeEvent) => {
          if (event.type === "run" && event.id === String(id)) wake();
        };
        const heartbeat = setInterval(() => {
          void stream.write(": heartbeat\n\n").catch(() => stream.abort());
        }, HEARTBEAT_MS);
        store.changes.on("change", onChange);
        stream.onAbort(() => wake());
        try {
          while (!stream.aborted) {
            // Read the status first: a finished run has already closed its log file.
            const run = store.runById(id);
            const finished =
              run?.status !== "queued" && run?.status !== "running";
            const path =
              run?.log_path &&
              (await internalFile(config.workDir, run.item_id, run.log_path));
            if (path)
              position = await sendLog(stream, path, position, finished);
            if (finished) {
              await stream.writeSSE({
                event: "end",
                data: "",
                id: String(position),
              });
              break;
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, LOG_TAIL_MS);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          }
        } finally {
          clearInterval(heartbeat);
          store.changes.off("change", onChange);
        }
      });
    });
  api.notFound((c) =>
    c.json(apiError("not_found", "API route not found"), 404),
  );
  api.onError((error, c) =>
    error instanceof HTTPException && error.status === 400
      ? c.json(apiError("invalid", error.message), 400)
      : c.json(apiError("internal", "Internal server error"), 500),
  );
  return api;
}

export type AppType = ReturnType<typeof createApi>;
