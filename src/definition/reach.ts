// What a definition lets its agents reach, as readable lines. A reload whose
// lines are not all approved waits for the operator (ADR 0005).
import { DEFAULT_EGRESS_ALLOW } from "../runner/docker.ts";
import type { Definition } from "./load.ts";
import type { RunnerFile } from "./schema.ts";

/** An agent's container and the hosts it may reach; undefined when it runs on the host. */
export function sandboxOf(
  runners: Map<string, RunnerFile>,
  runner: string | undefined,
): { image: string; allow: string[] } | undefined {
  const r = runner ? runners.get(runner) : undefined;
  const image = r?.platform?.linux?.dockerImage;
  return image
    ? { image, allow: r.egress?.allow ?? DEFAULT_EGRESS_ALLOW }
    : undefined;
}

/** Runner lines, which reach recorded before they counted lacks. */
export const RUNNER_LINE =
  /^([^·]+ · runner host|runner [^·]+ · (container|egress) [^·]+)$/;

/** One line per thing an agent can reach: where it runs and the hosts its container may reach, a server's command, URL, header, env or tool name, and each secret. */
export function reachOf(def: Definition): string[] {
  const lines = new Set<string>();
  for (const agent of def.agents.values()) {
    const add = (what: string) => lines.add(`${agent.name} · ${what}`);
    const sandbox = sandboxOf(def.runners, agent.runner);
    // shortcut: a container's reach is recorded per runner, so an agent moved between two runners already in use is not caught; record the runner per agent if factories get several.
    if (!sandbox) add("runner host");
    else {
      const runner = (what: string) =>
        lines.add(`runner ${agent.runner} · ${what}`);
      runner(`container ${sandbox.image}`);
      for (const host of sandbox.allow) runner(`egress ${host}`);
    }
    for (const secret of agent.secrets) add(`secret ${secret}`);
    for (const [name, s] of Object.entries(agent.mcpServers)) {
      const server = (what: string) => add(`${name} · ${what}`);
      if ("command" in s) {
        server(`command ${[s.command, ...(s.args ?? [])].join(" ")}`);
        for (const k of Object.keys(s.env ?? {})) server(`env ${k}`);
      } else if ("url" in s) {
        server(`url ${s.url}`);
        for (const k of Object.keys(s.headers ?? {})) server(`header ${k}`);
      } else continue;
      // No list: the whole server, which an agent gets anyway.
      for (const tool of s.tools ?? ["*"]) server(`tool ${tool}`);
    }
  }
  return [...lines].sort();
}

/** The lines of `next` that `approved` does not have. */
export const widening = (approved: string[], next: string[]) => {
  const known = new Set(approved);
  return next.filter((line) => !known.has(line));
};
