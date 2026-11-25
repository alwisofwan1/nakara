import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { Store } from "../db.ts";
import type { Definition, LoadResult, Problem } from "../definition/load.ts";
import type { McpServer } from "../definition/schema.ts";
import { hostForemanAllowed } from "../orchestrator/foreman-runner.ts";
import { credentialWarning, foremanTokenWarning } from "../runner/docker.ts";
import { protectionWarnings, readRepoStatus } from "../runner/repos.ts";

export interface ProblemDto {
  path: string;
  line: number | null;
  message: string;
}

export interface RepositoryDto {
  slug: string;
  state: "cloned" | "error" | "pending" | "deferred";
  defaultBranch: string | null;
  fetchedAt: string | null;
  error: string | null;
}

export interface FileDto {
  path: string;
  /** Top-level entries show their name, nested files their path below the folder. */
  label: string;
  kind: "file" | "folder";
  depth: 0 | 1;
  error: boolean;
}

export interface DefinitionDto {
  dir: string;
  /** The definition the factory runs; null when none ever loaded. */
  running: {
    name: string;
    label: string;
    schemaVersion: string;
    loadedAt: string;
  } | null;
  errors: ProblemDto[];
  warnings: ProblemDto[];
  /** What a held reload would let agents reach that the running definition does not; null when nothing waits. */
  pendingReach: string[] | null;
  repositories: RepositoryDto[];
  /** Agent credentials and repository protection that leave agents too much power. */
  security: string[];
  agentDefaults: { key: string; value: string }[];
  mcpServers: {
    name: string;
    kind: "command" | "url" | "warp";
    target: string;
  }[];
  files: FileDto[];
}

export interface CheckResultDto {
  ok: boolean;
  errors: ProblemDto[];
  warnings: ProblemDto[];
}

export const problemDto = (p: Problem): ProblemDto => ({
  path: p.path,
  line: p.line ?? null,
  message: p.message,
});

export const checkResultDto = (result: LoadResult): CheckResultDto => ({
  ok: result.ok,
  errors: result.ok ? [] : result.errors.map(problemDto),
  warnings: result.warnings.map(problemDto),
});

/** Every file below the definition root, relative and sorted; dotfiles are skipped. */
export async function definitionFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) =>
      relative(root, join(e.parentPath, e.name)).replaceAll("\\", "/"),
    )
    .filter((path) => !path.split("/").some((part) => part.startsWith(".")))
    .sort();
}

function fileTree(files: string[], errors: ProblemDto[]): FileDto[] {
  const broken = new Set(errors.map((e) => e.path));
  const rootFiles = files.filter((f) => !f.includes("/"));
  const folders = [
    ...new Set(
      files.filter((f) => f.includes("/")).map((f) => f.split("/")[0] ?? ""),
    ),
  ].sort();
  return [
    ...rootFiles.map((path) => ({
      path,
      label: path,
      kind: "file" as const,
      depth: 0 as const,
      error: broken.has(path),
    })),
    ...folders.flatMap((folder) => [
      {
        path: `${folder}/`,
        label: `${folder}/`,
        kind: "folder" as const,
        depth: 0 as const,
        error: broken.has(`${folder}/`) || broken.has(folder),
      },
      ...files
        .filter((f) => f.startsWith(`${folder}/`))
        .map((path) => ({
          path,
          label: path.slice(folder.length + 1),
          kind: "file" as const,
          depth: 1 as const,
          error: broken.has(path),
        })),
    ]),
  ];
}

/** Arguments, URL credentials, query and fragment may hold secrets; none reach the browser. */
function mcpServer(name: string, server: McpServer) {
  if ("command" in server)
    return {
      name,
      kind: "command" as const,
      target: server.args?.length ? `${server.command} …` : server.command,
    };
  if ("url" in server) {
    let target = "(invalid URL)";
    try {
      const url = new URL(server.url);
      target = `${url.origin}${url.pathname}`;
    } catch {
      /* An unparsable URL is not echoed back. */
    }
    return { name, kind: "url" as const, target };
  }
  return { name, kind: "warp" as const, target: server.warpId };
}

function agentDefaults(def: Definition) {
  const d = def.factory.agentDefaults;
  const rows: { key: string; value: string }[] = [];
  if (d.harness) {
    rows.push({ key: "harness", value: d.harness.type });
    rows.push({ key: "model", value: d.harness.model ?? "harness default" });
    if (d.harness.reasoningLevel)
      rows.push({ key: "reasoningLevel", value: d.harness.reasoningLevel });
  } else if (d.model) rows.push({ key: "model", value: d.model });
  if (d.runner) {
    const image = def.runners.get(d.runner)?.platform?.linux?.dockerImage;
    rows.push({
      key: "runner",
      value: image ? `${d.runner} (${image})` : d.runner,
    });
  }
  if (d.idleTimeoutMinutes)
    rows.push({
      key: "idleTimeoutMinutes",
      value: String(d.idleTimeoutMinutes),
    });
  if (d.workerHost) rows.push({ key: "workerHost", value: d.workerHost });
  if (d.secrets?.length)
    rows.push({ key: "secrets", value: d.secrets.join(", ") });
  return rows;
}

/** What gives agents more reach than intended; shown on the definition page and in /healthz. */
export function securityWarnings(
  store: Store,
  def: Definition | undefined,
): string[] {
  const credential = credentialWarning();
  const foremanToken = foremanTokenWarning();
  return [
    ...(credential ? [credential] : []),
    ...(foremanToken ? [foremanToken] : []),
    ...(hostForemanAllowed()
      ? [
          "NAKARA_ALLOW_HOST_FOREMAN=1: a foreman whose runner has no sandbox runs on the host with your full access (home, network, gh login).",
        ]
      : []),
    ...(def ? protectionWarnings(store, def) : []),
  ];
}

/** Read-only projection of the running definition, its problems and repository access. */
export function readDefinition(
  store: Store,
  state: {
    dir: string;
    definition: Definition | undefined;
    problems: { errors: Problem[]; warnings: Problem[] };
    pendingReach?: string[] | null;
    files: string[];
  },
): DefinitionDto {
  const def = state.definition;
  const errors = state.problems.errors.map(problemDto);
  return {
    dir: state.dir,
    running: def
      ? {
          name: def.factory.name,
          label: def.label,
          schemaVersion: def.factory.schemaVersion,
          loadedAt: def.loadedAt,
        }
      : null,
    errors,
    warnings: state.problems.warnings.map(problemDto),
    pendingReach: state.pendingReach ?? null,
    repositories: (def?.factory.repositories ?? []).map((repo) => {
      const slug = `${repo.owner}/${repo.name}`;
      const status = readRepoStatus(store, slug);
      return {
        slug,
        state: repo.deferred
          ? "deferred"
          : !status
            ? "pending"
            : status.error
              ? "error"
              : "cloned",
        defaultBranch: status?.defaultBranch ?? null,
        fetchedAt: status?.fetchedAt ?? null,
        error: repo.deferred ? null : (status?.error ?? null),
      };
    }),
    security: securityWarnings(store, def),
    agentDefaults: def ? agentDefaults(def) : [],
    mcpServers: Object.entries({
      ...def?.factory.mcpServers,
      ...def?.factory.agentDefaults.mcpServers,
    }).map(([name, server]) => mcpServer(name, server)),
    files: fileTree(state.files, errors),
  };
}
