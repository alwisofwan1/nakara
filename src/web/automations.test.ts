import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store, stubFactorySeed } from "../db.ts";
import {
  type AutomationDef,
  type Definition,
  fileRevision,
} from "../definition/load.ts";
import { loadConfig } from "../config.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { createApi } from "./api.ts";
import { cronMatches, parseCron, Scheduler } from "../intake/schedule.ts";
import {
  type AutomationDto,
  nextFire,
  readAutomations,
} from "./automations.ts";

const now = new Date("2026-10-22T12:34:30Z");
const definitions: AutomationDef[] = [
  {
    name: "weekly",
    agent: "foreman",
    instructions: "Check tests.\n\nReport results.",
    frontmatter: {
      enabled: false,
      displayName: "Weekly check",
      triggers: [
        {
          provider: "schedule",
          event: "cron_fired",
          schedule: { cron: "0 2 * * 1" },
        },
        { provider: "nakara", event: "manual" },
      ],
    },
  },
];

test("next fire scans strictly future UTC minutes with parser semantics and a bound", () => {
  assert.equal(nextFire("* * * * *", now), "2026-10-22T12:35:00.000Z");
  assert.equal(
    nextFire("@daily", new Date("2026-12-31T23:59:00Z")),
    "2027-01-01T00:00:00.000Z",
  );
  assert.equal(nextFire("0 2 * * 1", now), "2026-10-26T02:00:00.000Z");
  assert.equal(nextFire("0 0 29 2 *", now), "2028-02-29T00:00:00.000Z");
  assert.equal(nextFire("0 0 31 2 *", now), null);
  assert.equal(nextFire("0 0 1 * 0", now), "2026-10-25T00:00:00.000Z");
  assert.equal(nextFire("*/5 * * * *", now, 1), "2026-10-22T12:35:00.000Z");
  assert.equal(nextFire("@daily", now, 1), null);
  assert.throws(() => nextFire("invalid", now));
});

test("next fire skips non-matching days and agrees with a minute-by-minute scan", () => {
  const started = performance.now();
  assert.equal(nextFire("0 0 31 2 *", now), null);
  assert.ok(performance.now() - started < 100);
  const brute = (cron: string, bound: number) => {
    const parsed = parseCron(cron);
    const date = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    for (let minute = 0; minute < bound; minute++) {
      date.setTime(date.getTime() + 60_000);
      if (cronMatches(parsed, date)) return date.toISOString();
    }
    return null;
  };
  for (const cron of ["30 12 * * *", "15,45 */6 1,15 * 5", "0 9-17 * 11 1-5"])
    for (const bound of [1, 60, 24 * 60, 60 * 24 * 60])
      assert.equal(
        nextFire(cron, now, bound),
        brute(cron, bound),
        `${cron} within ${bound}`,
      );
});

test("automation projection includes disabled definitions, triggers and bounded item history without writes", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    assert.deepEqual(readAutomations(store, [], now), []);
    const empty = readAutomations(store, definitions, now)[0];
    assert.ok(empty);
    assert.equal(empty.description, "Check tests.");
    assert.equal(empty.itemCount, 0);
    assert.equal(empty.enabled, false);
    assert.equal(empty.triggers[0]?.nextFire, "2026-10-26T02:00:00.000Z");
    assert.equal(empty.triggers[1]?.nextFire, null);
    for (let i = 0; i < 207; i++)
      store.createItem({
        title: `Item ${i}`,
        request: "private request",
        source: "manual",
        automation: "weekly",
      });
    store.createItem({
      title: "Other",
      request: "",
      source: "manual",
      automation: "other",
    });
    const dto = readAutomations(store, definitions, now)[0];
    assert.ok(dto);
    assert.equal(dto.itemCount, 207);
    assert.deepEqual(
      dto.recentItems.map((item) => item.id),
      [207, 206, 205, 204, 203],
    );
    assert.ok(!JSON.stringify(dto).includes("private request"));
    assert.deepEqual(readAutomations(store, definitions, now)[0], dto);
    // Only schedule/cron_fired has a validated, firing cron.
    const [webhook] = readAutomations(
      store,
      [
        {
          name: "webhook",
          agent: "foreman",
          instructions: "",
          frontmatter: {
            enabled: true,
            triggers: [
              {
                provider: "github",
                event: "issue_labeled",
                schedule: { cron: "not a cron" },
              },
            ],
          },
        },
      ],
      now,
    );
    assert.equal(webhook?.triggers[0]?.cron, null);
    assert.equal(webhook?.triggers[0]?.nextFire, null);
    assert.deepEqual(webhook?.triggers[0]?.filter, {});
    // Without a labels filter, a labeled trigger shows the factory's label it polls.
    const labeled = (
      filter: Record<string, unknown> | undefined,
    ): AutomationDef => ({
      name: "labeled",
      agent: "foreman",
      instructions: "",
      frontmatter: {
        enabled: true,
        triggers: [{ provider: "github", event: "issue_labeled", filter }],
      },
    });
    const filterOf = (automation: AutomationDef) =>
      readAutomations(store, [automation], now, "factory:Harbor")[0]
        ?.triggers[0]?.filter;
    assert.deepEqual(filterOf(labeled(undefined)), {
      labels: ["factory:Harbor"],
    });
    assert.deepEqual(filterOf(labeled({ repos: [] })), {
      labels: ["factory:Harbor"],
      repos: [],
    });
    assert.deepEqual(filterOf(labeled({ labels: ["bug"] })), {
      labels: ["bug"],
    });
  } finally {
    store.db.close();
  }
});

test("automations API validates inputs and reads the latest definition", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const registry = new FactoryRegistry(store, loadConfig({}));
    const activate = (automations: AutomationDef[]) => {
      registry.default.definition = { automations } as unknown as Definition;
    };
    activate([]);
    const api = createApi(registry, loadConfig({}));
    assert.deepEqual(
      await (await api.request("/f/default/automations")).json(),
      [],
    );
    activate(definitions);
    const response = await api.request("/f/default/automations");
    assert.equal(response.status, 200);
    assert.equal(
      ((await response.json()) as { name: string }[])[0]?.name,
      "weekly",
    );
    const invalid = await api.request("/f/default/automations?unexpected=1");
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      "invalid_input",
    );
  } finally {
    store.db.close();
  }
});

test("the enabled switch and instructions save to automation.md, reload, and Run now creates a manual item", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-automations-"));
  const root = join(dir, "factory");
  await cp("factory", root, { recursive: true });
  const store = new Store(":memory:", {
    defaultBudgetUsd: 15,
    factory: () => ({ ...stubFactorySeed(), definition_dir: root }),
  });
  const registry = new FactoryRegistry(
    store,
    loadConfig({ NAKARA_DATA_DIR: dir }),
  );
  const factory = registry.default;
  // Items are created, but no foreman turn starts.
  factory.pump = async () => {};
  try {
    await factory.reloadDefinition();
    const api = createApi(registry, factory.config);
    const scheduler = new Scheduler(factory);
    const send = (method: string, path: string, body?: unknown) =>
      api.request(`/f/default${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const read = async () =>
      (
        (await (
          await api.request("/f/default/automations")
        ).json()) as AutomationDto[]
      ).find((a) => a.name === "weekly-health-check");
    const path = join(root, "automations/weekly-health-check/automation.md");
    const weekly = await read();
    assert.equal(weekly?.enabled, false);
    assert.equal(weekly?.revision, fileRevision(await readFile(path)));
    const revision = weekly?.revision ?? "";

    assert.equal(
      (await send("PUT", "/automations/weekly-health-check", { enabled: true }))
        .status,
      400,
    );
    assert.equal(
      (await send("PUT", "/automations/missing", { enabled: true, revision }))
        .status,
      404,
    );
    const enabled = await send("PUT", "/automations/weekly-health-check", {
      enabled: true,
      revision,
    });
    assert.equal(enabled.status, 200);
    const saved = (await enabled.json()) as { ok: boolean; revision: string };
    assert.equal(saved.ok, true);
    assert.equal(saved.revision, fileRevision(await readFile(path)));
    assert.match(await readFile(path, "utf8"), /^enabled: true$/m);
    assert.equal((await read())?.enabled, true);
    // Mondays 02:00 UTC: the enabled schedule fires once.
    scheduler.tick(new Date("2026-10-26T02:00:10Z"));
    assert.equal(store.automationHistory("weekly-health-check").count, 1);
    // Scheduled work has no Requester.
    assert.equal(
      store.items().find((i) => i.source === "schedule")?.requester,
      null,
    );

    // The form from before the save is stale.
    const stale = await send("PUT", "/automations/weekly-health-check", {
      enabled: false,
      revision,
    });
    assert.equal(stale.status, 409);
    assert.equal(
      ((await stale.json()) as { error: { code: string } }).error.code,
      "conflict",
    );
    const disabled = await send("PUT", "/automations/weekly-health-check", {
      enabled: false,
      revision: saved.revision,
    });
    assert.equal(disabled.status, 200);
    assert.equal((await read())?.enabled, false);
    // A disabled schedule no longer fires.
    scheduler.tick(new Date("2026-11-02T02:00:10Z"));
    assert.equal(store.automationHistory("weekly-health-check").count, 1);

    // Instructions round-trip; the switch keeps its value.
    const current = (await read())?.revision ?? "";
    const edited = await send("PUT", "/automations/weekly-health-check", {
      instructions: "Run the tests.\n\nReport failures as issues.",
      revision: current,
    });
    assert.equal(edited.status, 200);
    const after = await read();
    assert.equal(
      after?.instructions,
      "Run the tests.\n\nReport failures as issues.",
    );
    assert.equal(after?.enabled, false);
    assert.equal(
      factory.definition?.automations.find(
        (a) => a.name === "weekly-health-check",
      )?.instructions,
      "Run the tests.\n\nReport failures as issues.",
    );

    const policy = async (response: Response) => {
      assert.equal(response.status, 409);
      return (
        (await response.json()) as { error: { code: string; message: string } }
      ).error;
    };
    // A disabled automation does not run, as New work refuses it.
    assert.deepEqual(
      await policy(await send("POST", "/automations/weekly-health-check/run")),
      {
        code: "policy",
        message: "weekly-health-check is not an enabled automation.",
      },
    );
    assert.equal(store.automationHistory("weekly-health-check").count, 1);

    // Run now: the schedule's item, with source manual and the automation.
    await send("PUT", "/automations/weekly-health-check", {
      enabled: true,
      revision: (await read())?.revision,
    });
    const run = await send("POST", "/automations/weekly-health-check/run");
    assert.equal(run.status, 201);
    const { id, title } = (await run.json()) as { id: number; title: string };
    const item = store.item(id);
    assert.equal(item?.source, "manual");
    assert.equal(item?.automation, "weekly-health-check");
    assert.equal(item?.requester, "operator");
    assert.match(
      title,
      /^Weekly health check \(\d{4}-\d\d-\d\d \d\d:\d\d UTC\)$/,
    );
    assert.match(
      item?.request ?? "",
      /^Scheduled run of Weekly health check \(cron `0 2 \* \* 1`, UTC\)/,
    );
    assert.equal(store.automationHistory("weekly-health-check").count, 2);
    // An event-triggered automation needs its event's request: New work, not Run now.
    const labeled = await policy(
      await send("POST", "/automations/issue-labeled/run"),
    );
    assert.equal(labeled.code, "policy");
    assert.match(labeled.message, /no schedule/);
    assert.equal(store.automationHistory("issue-labeled").count, 0);
    assert.equal((await send("POST", "/automations/missing/run")).status, 404);
    // Without a loaded definition, both writes and runs are policy refusals.
    factory.definition = undefined;
    assert.equal(
      (await policy(await send("POST", "/automations/weekly-health-check/run")))
        .code,
      "policy",
    );
    assert.equal(
      (
        await policy(
          await send("PUT", "/automations/weekly-health-check", {
            enabled: false,
            revision: (await read())?.revision ?? "0".repeat(64),
          }),
        )
      ).code,
      "policy",
    );
    assert.equal(store.automationHistory("weekly-health-check").count, 2);
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the name, trigger and starting agent save through the API; refused edits return 422 and write nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-automations-"));
  const root = join(dir, "factory");
  await cp("factory", root, { recursive: true });
  const path = join(root, "automations/telegram-request/automation.md");
  // Two triggers: the drawer shows them read-only.
  await mkdir(join(root, "automations/chat"));
  await writeFile(
    join(root, "automations/chat/automation.md"),
    "---\ntriggers:\n  - provider: telegram\n    event: message\n  - provider: slack\n    event: message\n    filter: { members: [U0123ABC] }\n---\nChat.\n",
  );
  const store = new Store(":memory:", {
    defaultBudgetUsd: 15,
    factory: () => ({ ...stubFactorySeed(), definition_dir: root }),
  });
  const registry = new FactoryRegistry(
    store,
    loadConfig({ NAKARA_DATA_DIR: dir }),
  );
  const factory = registry.default;
  try {
    assert.ok((await factory.reloadDefinition())?.ok);
    const api = createApi(registry, factory.config);
    const put = (name: string, body: unknown) =>
      api.request(`/f/default/automations/${name}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const read = async (name: string) =>
      (
        (await (
          await api.request("/f/default/automations")
        ).json()) as AutomationDto[]
      ).find((a) => a.name === name);
    const refused = async (name: string, file: string, body: object) => {
      const before = await readFile(file, "utf8");
      const response = await put(name, {
        revision: fileRevision(Buffer.from(before)),
        ...body,
      });
      assert.equal(response.status, 422);
      const { error } = (await response.json()) as {
        error: { code: string; problems: { message: string }[] };
      };
      assert.equal(error.code, "invalid_definition");
      assert.equal(await readFile(file, "utf8"), before);
      return error.problems.map((p) => p.message).join("\n");
    };

    assert.match(
      await refused("telegram-request", path, {
        trigger: { kind: "schedule", cron: "every day" },
      }),
      /must have 5 fields/,
    );
    assert.match(
      await refused("telegram-request", path, { agent: "ghost" }),
      /agent "ghost" is not defined/,
    );
    const chat = join(root, "automations/chat/automation.md");
    assert.match(
      await refused("chat", chat, {
        displayName: "Chat",
        trigger: { kind: "telegram" },
      }),
      /several triggers/,
    );
    // An unknown trigger kind is a bad request.
    assert.equal(
      (
        await put("telegram-request", {
          revision: (await read("telegram-request"))?.revision,
          trigger: { kind: "comment", prefix: "/nakara" },
        })
      ).status,
      400,
    );

    const saved = await put("telegram-request", {
      revision: (await read("telegram-request"))?.revision,
      displayName: "Nightly report",
      agent: "triage",
      trigger: { kind: "schedule", cron: "0 3 * * *" },
    });
    assert.equal(saved.status, 200);
    const after = await read("telegram-request");
    assert.equal(after?.displayName, "Nightly report");
    assert.equal(after?.agent, "triage");
    assert.deepEqual(
      after?.triggers.map((t) => [t.provider, t.event, t.cron]),
      [["schedule", "cron_fired", "0 3 * * *"]],
    );
    assert.ok(after?.triggers[0]?.nextFire);

    const preview = async (cron: string) =>
      (
        await api.request(
          `/f/default/automations/cron-preview?cron=${encodeURIComponent(cron)}`,
        )
      ).json();
    assert.deepEqual(await preview("* * 31 2 *"), {
      valid: true,
      nextFire: null,
    });
    assert.equal(
      ((await preview("@daily")) as { nextFire: string }).nextFire.slice(11),
      "00:00:00.000Z",
    );
    assert.equal(((await preview("nope")) as { valid: boolean }).valid, false);
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
