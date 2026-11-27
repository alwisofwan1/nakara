// A compatible subset of Warp's factory definition schema v1alpha1
// (https://docs.warp.dev/factories/factory-as-code/). Unknown keys are kept and
// reported as warnings so Warp example trees load unchanged.
import { z } from "zod";

import { AGENT_TYPES } from "../domain/policy.ts";

/** Nakara extension: the server's tools the foreman may call. */
const tools = z.array(z.string().regex(/^[\w-]+$/)).optional();

const mcpServer = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    tools,
  }),
  z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    tools,
  }),
  z.object({ warpId: z.string() }),
]);

// `claude-code` is Warp's alias of `claude`; `qwen` is a Nakara extension for the
// self-hosted gateway.
export const HARNESS_TYPES = [
  "claude",
  "claude-code",
  "codex",
  "oz",
  "qwen",
] as const;

const harness = z.looseObject({
  type: z.enum(HARNESS_TYPES),
  /** Required by Warp; Nakara falls back to the harness's own default. */
  model: z.string().optional(),
  reasoningLevel: z.string().optional(),
  auth: z.unknown().optional(),
});

/**
 * Nakara extension: the harnesses a fresh run moves to, in order, when its own
 * hits a rate or usage limit. An entry is a kind (`codex`) or a harness
 * (`{ type: codex, model: gpt-5 }`); the loader checks the kinds.
 */
const fallback = z
  .array(
    z.union([
      z.string(),
      z.looseObject({
        type: z.string(),
        model: z.string().optional(),
        reasoningLevel: z.string().optional(),
      }),
    ]),
  )
  .optional();

const execution = {
  model: z.string().optional(),
  harness: harness.optional(),
  fallback,
  runner: z.string().optional(),
  secrets: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), mcpServer).optional(),
  workerHost: z.string().nullable().optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(60).nullable().optional(),
};

// Owner and name become paths and `gh --repo` arguments: only GitHub's characters.
const repoRef = z.object({
  owner: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/, "owner must be a GitHub user or organization"),
  name: z
    .string()
    .regex(
      /^(?!\.\.?$)[A-Za-z0-9._-]+$/,
      "name must be a GitHub repository name",
    ),
  codeForge: z.string().optional(),
  deferred: z.boolean().optional(),
});

/** At most this many `verify` commands per repository. */
export const MAX_VERIFY_COMMANDS = 20;
/** The total time a repository's `verify` commands may take when it names none. */
export const DEFAULT_VERIFY_TIMEOUT_MINUTES = 20;

/**
 * Nakara extension: a factory repository may list the commands Nakara runs on
 * the pushed PR head after an implementation run (`verify`), the runner they
 * run on (default: the implement agent's), and their total timeout.
 */
const factoryRepo = repoRef.extend({
  verify: z
    .array(z.string().trim().min(1, "a verify command cannot be empty"))
    .max(
      MAX_VERIFY_COMMANDS,
      `verify takes at most ${MAX_VERIFY_COMMANDS} commands`,
    )
    .optional(),
  runner: z.string().optional(),
  verifyTimeoutMinutes: z.number().int().min(1).max(240).optional(),
});

export const factorySchema = z.looseObject({
  schemaVersion: z.literal("v1alpha1"),
  name: z.string().min(1),
  description: z.string().optional(),
  alias: z
    .string()
    .max(60)
    .regex(/^[A-Za-z0-9 ._-]+$/)
    .optional(),
  repositories: z.array(factoryRepo),
  integrations: z.array(z.looseObject({ type: z.string() })).optional(),
  secrets: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), mcpServer).optional(),
  agentDefaults: z
    .looseObject(execution)
    .refine((d) => (d.model === undefined) !== (d.harness === undefined), {
      message: "agentDefaults must declare exactly one of `model` or `harness`",
    }),
});

export const agentFrontmatterSchema = z
  .looseObject({
    description: z.string().optional(),
    agentType: z
      .string()
      .transform((t) => (t === "MAIN" ? "FOREMAN" : t))
      .pipe(z.enum(AGENT_TYPES))
      .default("CUSTOM"),
    spawnableBy: z.array(z.string()).optional(),
    required_repos: z.array(repoRef).optional(),
    ...execution,
  })
  .refine((a) => a.model === undefined || a.harness === undefined, {
    message: "`model` and `harness` are mutually exclusive",
  });

const trigger = z.looseObject({
  provider: z.string(),
  event: z.string(),
  filter: z.record(z.string(), z.unknown()).optional(),
  schedule: z
    .object({ name: z.string().optional(), cron: z.string() })
    .optional(),
});

export const automationFrontmatterSchema = z.looseObject({
  enabled: z.boolean().default(true),
  agent: z.string().optional(),
  displayName: z.string().nullable().optional(),
  triggers: z.array(trigger).min(1),
  ...execution,
});

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
/** `host.name` exactly, or `*.` before at least two labels (so not `*.com`). */
const EGRESS_HOST = new RegExp(
  `^(?:${LABEL}(?:\\.${LABEL})*|\\*\\.${LABEL}(?:\\.${LABEL})+)$`,
  "i",
);

export const runnerSchema = z.looseObject({
  description: z.string().optional(),
  setupCommands: z.array(z.string()).optional(),
  instanceShape: z
    .object({ vcpus: z.number(), memoryGb: z.number() })
    .optional(),
  /** Nakara extension: hosts a docker runner's containers may reach. */
  egress: z
    .object({
      allow: z.array(
        z
          .string()
          .regex(
            EGRESS_HOST,
            "must be a host name or *.domain.tld (no scheme, port, path or bare-TLD wildcard)",
          ),
      ),
    })
    .optional(),
  platform: z
    .looseObject({
      os: z.enum(["linux", "macos", "windows"]).default("linux"),
      arch: z.string().optional(),
      linux: z.object({ dockerImage: z.string() }).loose().optional(),
    })
    .optional(),
});

export const scorerFrontmatterSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  agents: z.union([
    z.string(),
    z.array(z.union([z.string(), z.object({ name: z.string() }).loose()])),
  ]),
  labels: z
    .array(
      z.object({
        value: z.string(),
        score: z.number().min(0).max(1),
        description: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
  passingScore: z.number().min(0).max(1),
  samplingRate: z.number().min(0).max(100).default(25),
  model: z.string(),
});

export type FactoryFile = z.infer<typeof factorySchema>;
export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;
export type AutomationFrontmatter = z.infer<typeof automationFrontmatterSchema>;
export type RunnerFile = z.infer<typeof runnerSchema>;
export type ScorerFrontmatter = z.infer<typeof scorerFrontmatterSchema>;
export type McpServer = z.infer<typeof mcpServer>;
export type HarnessSpec = z.infer<typeof harness>;
export type FallbackSpec = NonNullable<z.infer<typeof fallback>>[number];
