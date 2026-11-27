import {
  type EnsureQueryDataOptions,
  type QueryClient,
  type QueryKey,
  queryOptions,
} from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import {
  type ClientResponse,
  hc,
  type InferRequestType,
  type parseResponse,
} from "hono/client";
import type { AppType, RunStatus } from "../../src/web/api.ts";
import { factories, serverUrl } from "../app/runtime";

const client = hc<AppType>(serverUrl("/api"));
/** The routes of one factory, under /api/f/<slug>/. */
const factoryApi = client.f[":slug"];

export interface ApiProblem {
  path: string;
  line: number | null;
  message: string;
}
export class ApiError extends Error {
  code = "";
  /** Definition problems behind a refused edit. */
  problems: ApiProblem[] = [];
}
/** A page loader's data; a 404 from the server shows the Page not found page. */
export const loadPage = <T, K extends QueryKey>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<T, Error, T, K>,
) =>
  queryClient.ensureQueryData(options).catch((error: unknown) => {
    throw error instanceof ApiError && error.code === "not_found"
      ? notFound()
      : error;
  });
const failure = async (response: Response, fallback: string) => {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; problems?: ApiProblem[] };
  } | null;
  const error = new ApiError(body?.error?.message ?? fallback);
  error.code = body?.error?.code ?? "";
  error.problems = body?.error?.problems ?? [];
  return error;
};

/**
 * The JSON of a 2xx response, typed as Hono's parseResponse types it; anything
 * else throws an ApiError, with `fallback` as the message if the server gave none.
 */
async function body<R extends ClientResponse<unknown>>(
  request: Promise<R>,
  fallback: string,
): ReturnType<typeof parseResponse<R>> {
  const response = await request;
  if (!response.ok) throw await failure(response as Response, fallback);
  return response.json() as never;
}

export const statusQuery = queryOptions({
  queryKey: ["status"],
  queryFn: () => body(client.status.$get(), "Unable to load status"),
});

export const setupQuery = queryOptions({
  queryKey: ["setup"],
  queryFn: () => body(client.setup.$get(), "Unable to load the setup checks"),
});

/** The settings of this Nakara, which span factories; the Settings page. */
export const instanceSettingsQuery = queryOptions({
  queryKey: ["settings"],
  queryFn: () => body(client.settings.$get(), "Unable to load the settings"),
});

/** Saves how many agent runs start at once; null returns to NAKARA_CONCURRENCY. */
export const saveConcurrency = (concurrency: number | null) =>
  body(
    client.settings.concurrency.$put({ json: { concurrency } }),
    "Unable to save the concurrency",
  );

export const verifyToken = (token: "agent" | "foreman") =>
  body(
    client.setup.verify.$post({ json: { token } }),
    "Unable to verify the token",
  );

export const definitionQuery = (slug: string) =>
  queryOptions({
    queryKey: ["definition", slug],
    queryFn: () =>
      body(
        factoryApi.definition.$get({ param: { slug } }),
        "Unable to load the definition",
      ),
  });
export const activityQuery = (slug: string) =>
  queryOptions({
    queryKey: ["items", { factory: slug }],
    queryFn: () =>
      body(
        factoryApi.items.$get({ param: { slug } }),
        "Unable to load activity",
      ),
  });

export const blueprintQuery = (slug: string) =>
  queryOptions({
    queryKey: ["blueprint", slug],
    queryFn: () =>
      body(
        factoryApi.blueprint.$get({ param: { slug } }),
        "Unable to load the blueprint",
      ),
  });

export const validateDefinition = (slug: string) =>
  body(
    factoryApi.definition.validate.$post({ param: { slug } }),
    "Unable to validate the definition",
  );

export const reloadDefinition = (slug: string) =>
  body(
    factoryApi.definition.reload.$post({ param: { slug } }),
    "Unable to reload the definition",
  );

export const decideReach = (
  slug: string,
  approve: boolean,
): Promise<{ ok: boolean }> =>
  approve
    ? body(
        factoryApi.definition.reach.approve.$post({ param: { slug } }),
        "Unable to approve",
      )
    : body(
        factoryApi.definition.reach.reject.$post({ param: { slug } }),
        "Unable to reject",
      );

export const runQuery = (id: number) =>
  queryOptions({
    queryKey: ["runs", id],
    queryFn: () =>
      body(
        client.runs[":id"].$get({ param: { id: String(id) } }),
        "Unable to load the run",
      ),
  });

export const runDiffQuery = (id: number) =>
  queryOptions({
    // Not under "runs": change events must not re-snapshot a live worktree.
    queryKey: ["run-diff", id],
    queryFn: () =>
      body(
        client.runs[":id"].diff.$get({ param: { id: String(id) } }),
        "Unable to load the diff",
      ),
  });

export const queueFollowUp = (id: number, message: string) =>
  body(
    client.runs[":id"]["follow-up"].$post({
      param: { id: String(id) },
      json: { message },
    }),
    "Unable to queue the follow-up",
  );

export const stopRun = (id: number) =>
  body(
    client.runs[":id"].stop.$post({ param: { id: String(id) } }),
    "Unable to stop the run",
  );

/** Needs-you items of every factory, or of the one with this slug. */
export const inboxQuery = (factory?: string) =>
  queryOptions({
    queryKey: ["inbox", { factory }],
    queryFn: () =>
      body(
        client.inbox.$get({ query: factory ? { factory } : {} }),
        "Unable to load the inbox",
      ),
  });

export const newWorkQuery = (slug: string) =>
  queryOptions({
    queryKey: ["new-work", slug],
    queryFn: () =>
      body(
        factoryApi["new-work"].$get({ param: { slug } }),
        "Unable to load the form",
      ),
  });

export type NewWork = InferRequestType<typeof factoryApi.items.$post>["json"];
/** Creates a work item in the factory with this slug. */
export const createWork = (slug: string, json: NewWork) =>
  body(
    factoryApi.items.$post({ param: { slug }, json }),
    "Unable to create the work item",
  );
export interface RunFilter {
  status?: RunStatus;
  agent?: string;
  /** A factory slug. */
  factory?: string;
}
export const runsQuery = ({ status, agent, factory }: RunFilter) =>
  queryOptions({
    queryKey: ["runs", { status, agent, factory }],
    queryFn: () =>
      body(
        client.runs.$get({
          query: {
            ...(status && { status }),
            ...(agent && { agent }),
            ...(factory && { factory }),
          },
        }),
        "Unable to load runs",
      ),
  });
export const automationsQuery = (slug: string) =>
  queryOptions({
    queryKey: ["automations", slug],
    queryFn: () =>
      body(
        factoryApi.automations.$get({ param: { slug } }),
        "Unable to load automations",
      ),
  });
export type AutomationSave = InferRequestType<
  (typeof factoryApi.automations)[":name"]["$put"]
>["json"];
/**
 * Writes automation.md and reloads the definition. A refused edit throws its
 * problems; a page older than the file throws code "conflict".
 */
export const saveAutomation = (
  slug: string,
  name: string,
  json: AutomationSave,
) =>
  body(
    factoryApi.automations[":name"].$put({ param: { slug, name }, json }),
    "Unable to save the automation",
  );

export type NewAutomation = InferRequestType<
  typeof factoryApi.automations.$post
>["json"];
/**
 * Writes automations/<name>/automation.md and reloads. A refused automation
 * throws its problems; a taken name throws code "conflict".
 */
export const createAutomation = (slug: string, json: NewAutomation) =>
  body(
    factoryApi.automations.$post({ param: { slug }, json }),
    "Unable to create the automation",
  );

/**
 * Deletes the automation's folder and reloads; its work items stay. A page
 * older than automation.md throws code "conflict".
 */
export const deleteAutomation = (
  slug: string,
  name: string,
  revision: string,
) =>
  body(
    factoryApi.automations[":name"].$delete({
      param: { slug, name },
      json: { revision },
    }),
    "Unable to delete the automation",
  );

/** The next fire time of a cron being edited, or valid: false. */
export const cronPreviewQuery = (slug: string, cron: string) =>
  queryOptions({
    queryKey: ["cron-preview", slug, cron],
    queryFn: () =>
      body(
        factoryApi.automations["cron-preview"].$get({
          param: { slug },
          query: { cron },
        }),
        "Unable to check the schedule",
      ),
    staleTime: 60_000,
  });

/** Run now: creates a work item for the automation, as its trigger would. */
export const runAutomation = (slug: string, name: string) =>
  body(
    factoryApi.automations[":name"].run.$post({ param: { slug, name } }),
    "Unable to run the automation",
  );
export const agentsQuery = (slug: string) =>
  queryOptions({
    queryKey: ["agents", slug],
    queryFn: () =>
      body(
        factoryApi.agents.$get({ param: { slug } }),
        "Unable to load agents",
      ),
  });
export const agentQuery = (slug: string, name: string) =>
  queryOptions({
    queryKey: ["agents", slug, name],
    queryFn: () =>
      body(
        factoryApi.agents[":name"].$get({ param: { slug, name } }),
        "Unable to load agent",
      ),
  });

/** The models a harness CLI offers, as it reports them; cached by the server for an hour. */
export const modelsQuery = (harness: "claude" | "codex") =>
  queryOptions({
    queryKey: ["models", harness],
    queryFn: async () => {
      const response = await client.models[":harness"].$get({
        param: { harness },
      });
      if (!response.ok)
        throw await failure(response, `Unable to list ${harness} models`);
      return (await response.json()).models;
    },
    staleTime: 10 * 60_000,
    retry: false,
  });

export type AgentSave = InferRequestType<
  (typeof factoryApi.agents)[":name"]["$put"]
>["json"];
export type AgentForm = Omit<AgentSave, "revision">;
/**
 * Writes agent.md and reloads the definition. A refused edit throws its problems;
 * a form older than the file throws code "conflict".
 */
export const saveAgent = (slug: string, name: string, json: AgentSave) =>
  body(
    factoryApi.agents[":name"].$put({ param: { slug, name }, json }),
    "Unable to save the agent",
  );

export type NewAgent = InferRequestType<typeof factoryApi.agents.$post>["json"];
/** Writes agents/<name>/agent.md and reloads; a refused agent throws its problems. */
export const createAgent = (slug: string, json: NewAgent) =>
  body(
    factoryApi.agents.$post({ param: { slug }, json }),
    "Unable to create the agent",
  );

/**
 * Deletes the agent's folder and reloads. A refusal throws code "policy" with
 * the loader's message; a page older than agent.md throws code "conflict".
 */
export const deleteAgent = (slug: string, name: string, revision: string) =>
  body(
    factoryApi.agents[":name"].$delete({
      param: { slug, name },
      json: { revision },
    }),
    "Unable to delete the agent",
  );

export const itemQuery = (id: number) =>
  queryOptions({
    queryKey: ["items", id],
    queryFn: () =>
      body(
        client.items[":id"].$get({ param: { id: String(id) } }),
        "Unable to load the work item",
      ),
  });

export const pullRequestQuery = (id: number) =>
  queryOptions({
    queryKey: ["pr", id],
    queryFn: () =>
      body(
        client.items[":id"].pr.$get({ param: { id: String(id) } }),
        "Unable to load the pull request",
      ),
  });

export const sendItemMessage = (id: number, message: string) =>
  body(
    client.items[":id"].messages.$post({
      param: { id: String(id) },
      json: { message },
    }),
    "Unable to send the message",
  );

export const cancelItem = (id: number) =>
  body(
    client.items[":id"].cancel.$post({ param: { id: String(id) } }),
    "Unable to cancel the work item",
  );

export const mergeItemPr = (id: number) =>
  body(
    client.items[":id"].merge.$post({ param: { id: String(id) } }),
    "Unable to merge the pull request",
  );

export const retryItem = (id: number) =>
  body(
    client.items[":id"].retry.$post({ param: { id: String(id) } }),
    "Unable to retry the run",
  );

export const raiseBudget = (id: number) =>
  body(
    client.items[":id"]["raise-budget"].$post({ param: { id: String(id) } }),
    "Unable to raise the budget",
  );

export const raiseRunLimit = (id: number) =>
  body(
    client.items[":id"]["raise-run-limit"].$post({ param: { id: String(id) } }),
    "Unable to raise the run limit",
  );

export type ApprovalDecision = InferRequestType<
  (typeof client.approvals)[":id"]["$post"]
>["json"];
export type LessonDecision = InferRequestType<
  (typeof client.lessons)[":id"]["$post"]
>["json"];
export const decideLesson = (id: number, json: LessonDecision) =>
  body(
    client.lessons[":id"].$post({ param: { id: String(id) }, json }),
    "Unable to send your decision",
  );

export const answerApproval = (id: number, json: ApprovalDecision) =>
  body(
    client.approvals[":id"].$post({ param: { id: String(id) }, json }),
    "Unable to send your decision",
  );

/** New factory wizard: the gh login, its owners and the agent token. */
export const wizardGithubQuery = queryOptions({
  queryKey: ["wizard", "github"],
  queryFn: () =>
    body(client.wizard.github.$get(), "Unable to check the gh login"),
});
export const wizardReposQuery = (owner: string) =>
  queryOptions({
    queryKey: ["wizard", "repos", owner],
    queryFn: () =>
      body(
        client.wizard.repos.$get({ query: { owner } }),
        "Unable to list the repositories",
      ),
  });
/** Which of the repositories the token agents of the factory `slug` get can see. */
export const wizardAccessQuery = (repos: string[], slug?: string) =>
  queryOptions({
    queryKey: ["wizard", "access", repos, slug ?? null],
    queryFn: () =>
      body(
        client.wizard.access.$get({
          query: { repos: repos.join(","), ...(slug && { slug }) },
        }),
        "Unable to check the agent token",
      ),
  });
/** The slug and handle a factory name suggests, and whether they are free. */
export const wizardNameQuery = (name: string) =>
  queryOptions({
    queryKey: ["wizard", "name", name],
    queryFn: () =>
      body(
        client.wizard.name.$get({ query: { name } }),
        "Unable to check the name",
      ),
  });
/** The example folders of warpdotdev/warp-factory-examples. */
export const wizardExamplesQuery = queryOptions({
  queryKey: ["wizard", "examples"],
  queryFn: () =>
    body(client.wizard.examples.$get(), "Unable to list the Warp examples"),
  staleTime: 10 * 60_000,
});
type TemplateChoice = InferRequestType<
  typeof client.wizard.template.$get
>["query"];
/** The agents and intake a template starts with. */
export const wizardTemplateQuery = (query: TemplateChoice) =>
  queryOptions({
    queryKey: ["wizard", "template", query],
    queryFn: () =>
      body(
        client.wizard.template.$get({ query }),
        "Unable to read the template",
      ),
  });
export type CreationBody = InferRequestType<
  typeof client.wizard.preview.$post
>["json"];
/** The files Create would write, validated; nothing is written. */
export const wizardPreviewQuery = (json: CreationBody) =>
  queryOptions({
    queryKey: ["wizard", "preview", json],
    queryFn: () =>
      body(
        client.wizard.preview.$post({ json }),
        "Unable to preview the factory",
      ),
  });
/** A creation job's progress; /api/events announces each step. */
export const creationQuery = (id: string) =>
  queryOptions({
    queryKey: ["creation", id],
    queryFn: () =>
      body(
        client.wizard.creations[":id"].$get({ param: { id } }),
        "Unable to load the progress",
      ),
  });
export const startCreation = (json: CreationBody) =>
  body(client.wizard.creations.$post({ json }), "Unable to create the factory");
export const retryCreation = (id: string) =>
  body(
    client.wizard.creations[":id"].retry.$post({ param: { id } }),
    "Unable to retry",
  );

/** The registered factories; the page's boot-time list until the first refetch. */
export const factoriesQuery = queryOptions({
  queryKey: ["factories"],
  queryFn: () => body(client.factories.$get(), "Unable to load the factories"),
  initialData: factories,
  // The boot-time list is fresh; /api/events announces changes after it.
  initialDataUpdatedAt: () => Date.now(),
});

export const factorySettingsQuery = (slug: string) =>
  queryOptions({
    queryKey: ["factories", slug],
    queryFn: () =>
      body(
        factoryApi.settings.$get({ param: { slug } }),
        "Unable to load the settings",
      ),
  });

export type FactoryRename = InferRequestType<
  typeof factoryApi.settings.$put
>["json"];
/** Renames the factory; a name another factory has throws code "policy". */
export const renameFactory = (slug: string, json: FactoryRename) =>
  body(
    factoryApi.settings.$put({ param: { slug }, json }),
    "Unable to save the settings",
  );

export type FactoryFileEdit = InferRequestType<
  typeof factoryApi.settings.definition.$put
>["json"];
/**
 * Writes the description or agent defaults into factory.yaml and reloads; a
 * stale revision throws code "conflict", an invalid definition its problems.
 */
export const saveFactoryFile = (slug: string, json: FactoryFileEdit) =>
  body(
    factoryApi.settings.definition.$put({ param: { slug }, json }),
    "Unable to save factory.yaml",
  );

export type LimitsEdit = InferRequestType<
  typeof factoryApi.settings.limits.$put
>["json"];
/** Saves the factory's limits for new Work Items; null resets one to its default. */
export const saveLimits = (slug: string, json: LimitsEdit) =>
  body(
    factoryApi.settings.limits.$put({ param: { slug }, json }),
    "Unable to save the limits",
  );

export type NotificationsEdit = InferRequestType<
  typeof factoryApi.settings.notifications.$put
>["json"];
/** Saves the factory's Slack channel or notification switches; a "#name" comes back as its channel ID. */
export const saveNotifications = (slug: string, json: NotificationsEdit) =>
  body(
    factoryApi.settings.notifications.$put({ param: { slug }, json }),
    "Unable to save the notifications",
  );

/** Pauses the factory: new Work Items wait in Intake; running work finishes. */
export const pauseFactory = (slug: string) =>
  body(
    factoryApi.pause.$post({ param: { slug } }),
    "Unable to pause the factory",
  );
/** Resumes the factory: the waiting work starts. */
export const resumeFactory = (slug: string) =>
  body(
    factoryApi.resume.$post({ param: { slug } }),
    "Unable to resume the factory",
  );

/** Deletes the factory; refused (code "policy") while it has active items. */
export const deleteFactory = (slug: string) =>
  body(factoryApi.$delete({ param: { slug } }), "Unable to delete the factory");

export type DefinitionMove = InferRequestType<
  typeof factoryApi.definition.move.$post
>["json"];
/** Moves a managed definition into a repository folder; it runs from there. */
export const moveDefinition = (slug: string, json: DefinitionMove) =>
  body(
    factoryApi.definition.move.$post({ param: { slug }, json }),
    "Unable to move the definition",
  );

/** Copies a repository definition into a Nakara-managed folder; it runs from there. */
export const adoptDefinition = (slug: string) =>
  body(
    factoryApi.definition.adopt.$post({ param: { slug } }),
    "Unable to have Nakara manage the definition",
  );
