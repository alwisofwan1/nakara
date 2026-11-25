import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { smokeDefinitionDir } from "./smoke.ts";

// These tests edit the server's definition files, so they never overlap.
test.describe.configure({ mode: "serial" });

test("definition page: repositories, defaults, files, validate and reload", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./definition");
  await expect(
    page.getByRole("heading", { name: "Factory definition", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Default" })
      .getByRole("link", { name: "Definition" }),
  ).toHaveAttribute("aria-current", "page");
  const repositories = page.getByRole("region", { name: "Repositories" });
  await expect(repositories).toContainText(
    /acme\/widgets\s*main\s*cloned · fetched/,
  );
  await expect(repositories).toContainText(
    "gh: GraphQL: Could not resolve to a Repository with the name 'acme/gadgets'. (repository)",
  );
  const security = page.getByRole("region", { name: "Security warnings" });
  await expect(security).toContainText("more power than they should");
  await expect(security).toContainText(
    "acme/widgets: main allows direct pushes or merges without an approving review",
  );
  await expect(security).toContainText(
    "Agent containers get your personal gh token",
  );
  const health = await (await page.request.get("./healthz")).json();
  expect(health.warnings).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Agent containers get your personal gh token"),
      expect.stringContaining("acme/widgets: main allows direct pushes"),
    ]),
  );
  await expect(
    page.getByRole("region", { name: "agentDefaults" }),
  ).toContainText(/harness\s*claude/);
  await expect(page.getByRole("region", { name: "mcpServers" })).toBeVisible();
  const files = page.getByRole("list", { name: "Definition files" });
  await expect(files).toContainText("factory.yaml");
  await expect(files).toContainText("implement/agent.md");
  await page.screenshot({
    path: testInfo.outputPath("definition-desktop.png"),
    fullPage: true,
  });

  // The dev project shares the root project's server; only one may edit its files.
  if (testInfo.project.name === "dev") {
    expect(errors).toEqual([]);
    return;
  }
  const baseURL = testInfo.project.use.baseURL ?? "";
  const broken = join(
    smokeDefinitionDir(Number(new URL(baseURL).port)),
    "agents/docs/agent.md",
  );
  await mkdir(join(broken, ".."), { recursive: true });
  await writeFile(
    broken,
    "---\ndescription: Docs\nharness:\n  type: gemini\n---\nDocs.\n",
  );
  try {
    const location = "agents/docs/agent.md:4";
    await page.getByRole("button", { name: "Validate" }).click();
    const validation = page
      .getByRole("status")
      .filter({ hasText: "Validation found 1 error. Nothing was applied." });
    await expect(validation).toContainText(location);
    await expect(
      page.getByRole("alert").filter({ hasNotText: "Lighthouse" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "Reload definition" }).click();
    await expect(
      page
        .locator(".toast")
        .getByText("Reload failed: 1 error", { exact: true }),
    ).toBeVisible();
    const banner = page
      .getByRole("alert")
      .filter({ hasText: /is still running/ });
    await expect(banner).toContainText(
      /Reload failed: 1 error\. The last valid definition \(.+\) is still running\./,
    );
    await expect(banner).toContainText(location);
    await expect(
      files.getByRole("listitem").filter({ hasText: "docs/agent.md" }),
    ).toHaveClass(/\bbroken\b/);
    // The factory keeps running the last valid definition.
    await expect(repositories).toContainText("acme/widgets");
    await expect(page.locator(".desktop-sidebar footer")).toContainText(
      "Slots · 1/2 busy",
    );
    await page.screenshot({
      path: testInfo.outputPath("definition-error-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(banner).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("definition-error-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await rm(join(broken, ".."), { recursive: true, force: true });
  }
  await page.getByRole("button", { name: "Reload definition" }).click();
  await expect(
    page.locator(".toast").getByText("Definition reloaded", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: /still running/ }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("definition-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("agent page edits settings and prompt, saves and reloads", async ({
  page,
}, testInfo) => {
  // One long walk (~20s idle); under the full parallel suite it passed 30s.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const save = page.getByRole("button", { name: "Save changes" });
  const prompt = page.getByRole("textbox", { name: "Prompt" });
  const settings = page.getByRole("tab", { name: "Settings", exact: true });

  // The dev project shares the root project's server; only one may edit its files.
  if (testInfo.project.name === "dev") {
    await page.goto("./agents/review");
    await expect(prompt).toHaveValue(/^# Review/);
    await expect(save).toBeDisabled();
    expect(errors).toEqual([]);
    return;
  }
  const baseURL = testInfo.project.use.baseURL ?? "";
  const dir = smokeDefinitionDir(Number(new URL(baseURL).port));
  const path = join(dir, "agents/review/agent.md");
  const original = await readFile(path, "utf8");
  // A .git folder above the definition makes it git-tracked.
  const git = join(dir, "..", ".git");
  await mkdir(git, { recursive: true });
  try {
    await page.goto("./agents/review");
    await expect(page.getByText("lives in a git-tracked folder")).toBeVisible();
    await expect(save).toBeDisabled();
    await prompt.fill("# Review\n\nReview the smoke change.");
    await settings.click();
    // The picker lists what the (fake) claude reports, then the model's reasoning levels.
    const model = page.getByRole("button", { name: "Model" });
    await expect(model).toContainText("gpt-5.6-terra");
    await model.click();
    const picker = page.getByRole("dialog", { name: "Choose a model" });
    await picker.getByRole("tab", { name: "Claude" }).click();
    await picker.getByRole("button", { name: /^Sonnet 5\.5/ }).click();
    await picker.getByRole("button", { name: "Max", exact: true }).click();
    await page.screenshot({
      path: testInfo.outputPath("agent-model-picker-desktop.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await page.getByRole("spinbutton", { name: "Idle timeout" }).fill("15");
    // Explicit, though it is the default: "local" would move it to the host and wait for approval.
    await page.getByRole("combobox", { name: "Runner" }).selectOption("docker");
    await page.screenshot({
      path: testInfo.outputPath("agent-settings-edit-desktop.png"),
      fullPage: true,
    });
    await save.click();
    await expect(
      page.locator(".toast").getByText("Agent saved", { exact: true }),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    // The page shows the reloaded definition.
    await expect(model).toContainText("Sonnet 5.5");
    await expect(model).toContainText("Max");
    await expect(
      page.getByRole("spinbutton", { name: "Idle timeout" }),
    ).toHaveValue("15");
    const written = await readFile(path, "utf8");
    expect(written).toContain(
      "  model: sonnet\n  reasoningLevel: max\nrunner: docker\nidleTimeoutMinutes: 15\n",
    );
    expect(written).toMatch(/---\n# Review\n\nReview the smoke change\.\n$/);
    await page.goto("./runs");
    await page.goto("./agents/review");
    await expect(prompt).toHaveValue("# Review\n\nReview the smoke change.");

    // A change on disk after the page loaded is a conflict, not a lost update.
    const onDisk = (await readFile(path, "utf8")).replace(
      "Review the smoke change.",
      "Changed on disk.",
    );
    await writeFile(path, onDisk);
    await prompt.fill("# Review\n\nStale edit.");
    await save.click();
    const stale = page
      .getByRole("alert")
      .filter({ hasText: "changed on disk since this form was loaded" });
    await expect(stale).toBeVisible();
    expect(await readFile(path, "utf8")).toBe(onDisk);
    await page.screenshot({
      path: testInfo.outputPath("agent-conflict-desktop.png"),
      fullPage: true,
    });
    await stale.getByRole("button", { name: "Reload" }).click();
    await expect(stale).toHaveCount(0);
    await expect(prompt).toHaveValue("# Review\n\nChanged on disk.");
    await expect(save).toBeDisabled();

    // An empty spawnableBy list is allowed but called out.
    await settings.click();
    await page
      .getByRole("combobox", { name: "Spawnable by" })
      .selectOption("some");
    await expect(page.getByText("No agent can spawn it.")).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByText("No agent can spawn it.")).toHaveCount(0);

    // The foreman needs the nakara MCP tools, which codex cannot load.
    await page.goto("./agents/foreman");
    await settings.click();
    const before = await readFile(join(dir, "agents/foreman/agent.md"), "utf8");
    await page.getByRole("button", { name: "Model" }).click();
    const foremanPicker = page.getByRole("dialog", { name: "Choose a model" });
    await foremanPicker.getByRole("tab", { name: "Codex" }).click();
    // Whatever codex lists here, a typed id is always accepted.
    await foremanPicker.getByRole("textbox").fill("gpt-smoke");
    await foremanPicker
      .getByRole("button", { name: "Use “gpt-smoke”" })
      .click();
    await page.keyboard.press("Escape");
    await save.click();
    const refused = page
      .getByRole("alert")
      .filter({ hasText: "nothing was saved" });
    await expect(refused).toContainText("agents/foreman/agent.md:4");
    await expect(refused).toContainText("cannot use the codex harness");
    expect(await readFile(join(dir, "agents/foreman/agent.md"), "utf8")).toBe(
      before,
    );
    await page.screenshot({
      path: testInfo.outputPath("agent-settings-error-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(refused).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("agent-settings-error-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(refused).toHaveCount(0);
    await page.goto("./agents/review");
    await settings.click();
    await page.screenshot({
      path: testInfo.outputPath("agent-settings-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await rm(git, { recursive: true, force: true });
    await writeFile(path, original);
  }
  await page.goto("./definition");
  await page.getByRole("button", { name: "Reload definition" }).click();
  await expect(
    page.locator(".toast").getByText("Definition reloaded", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("agents are created from + New agent and deleted from the danger zone", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const name = page.getByRole("textbox", { name: "Name" });
  const create = page.getByRole("button", { name: "Create agent" });

  await page.goto("./agents");
  await page.getByRole("link", { name: "+ New agent" }).click();
  await expect(page).toHaveURL(/\/agents\/new$/);
  await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();
  await expect(create).toBeDisabled();
  await name.fill("Docs Writer");
  await expect(page.getByText("Use lowercase letters")).toBeVisible();
  await expect(create).toBeDisabled();
  // The dev project shares the root project's server; only one may edit its files.
  if (testInfo.project.name === "dev") {
    expect(errors).toEqual([]);
    return;
  }
  const baseURL = testInfo.project.use.baseURL ?? "";
  const dir = smokeDefinitionDir(Number(new URL(baseURL).port));
  const folder = join(dir, "agents/docs-writer");
  const automation = join(dir, "automations/docs-refresh");
  try {
    await name.fill("docs-writer");
    await expect(
      page.getByText("Writes agents/docs-writer/agent.md"),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Agent type" })
      .selectOption("CUSTOM");
    await page
      .getByRole("textbox", { name: "Description" })
      .fill("Writes and updates the documentation.");
    await page
      .getByRole("textbox", { name: "Prompt" })
      .fill("# Docs\n\nKeep the README current.");
    await page.screenshot({
      path: testInfo.outputPath("agent-new-desktop.png"),
      fullPage: true,
    });
    await create.click();
    await expect(
      page.locator(".toast").getByText("Agent created", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/agents\/docs-writer$/);
    await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveValue(
      "# Docs\n\nKeep the README current.",
    );
    expect(await readFile(join(folder, "agent.md"), "utf8")).toBe(
      "---\ndescription: Writes and updates the documentation.\nagentType: CUSTOM\n---\n\n# Docs\n\nKeep the README current.\n",
    );
    // Listed under the foreman.
    await page.goto("./agents");
    const child = page.locator(".agent-child", { hasText: "docs-writer" });
    await expect(child).toContainText("Writes and updates the documentation.");
    await page.screenshot({
      path: testInfo.outputPath("agents-created-desktop.png"),
      fullPage: true,
    });

    // A name that is taken is refused.
    await page.goto("./agents/new");
    await name.fill("docs-writer");
    await create.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "already exists" }),
    ).toBeVisible();

    // An automation that names the agent keeps it.
    await mkdir(automation, { recursive: true });
    await writeFile(
      join(automation, "automation.md"),
      '---\ndisplayName: Docs refresh\nagent: docs-writer\nenabled: false\ntriggers:\n  - provider: schedule\n    event: cron_fired\n    schedule:\n      cron: "0 2 * * 1"\n---\nRefresh the docs.\n',
    );
    await page.goto("./agents/docs-writer");
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Danger zone" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Delete agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete docs-writer?" });
    await dialog.getByRole("button", { name: "Delete agent" }).click();
    const refused = dialog.getByRole("alert");
    await expect(refused).toContainText(
      'docs-writer cannot be deleted: agent "docs-writer" is not defined',
    );
    await expect(refused).toContainText(
      "automations/docs-refresh/automation.md:3",
    );
    expect(await readFile(join(folder, "agent.md"), "utf8")).toContain(
      "agentType: CUSTOM",
    );
    await page.screenshot({
      path: testInfo.outputPath("agent-delete-refused-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("agent-delete-refused-mobile.png"),
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Keep agent" }).click();

    // Without the reference, the agent is deleted.
    await rm(automation, { recursive: true });
    await page.getByRole("button", { name: "Delete agent" }).click();
    await dialog.getByRole("button", { name: "Delete agent" }).click();
    await expect(
      page.locator(".toast").getByText("Agent deleted", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.locator(".agent-card").first()).toBeVisible();
    await expect(
      page.locator(".agent-card", { hasText: "docs-writer" }),
    ).toHaveCount(0);
    await expect(readFile(join(folder, "agent.md"))).rejects.toThrow();

    await page.goto("./agents/new");
    await page.screenshot({
      path: testInfo.outputPath("agent-new-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
    await rm(automation, { recursive: true, force: true });
  }
  await page.goto("./definition");
  await page.getByRole("button", { name: "Reload definition" }).click();
  await expect(
    page.locator(".toast").getByText("Definition reloaded", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("automation switch, instructions and Run now write the definition and create work", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const toggle = page.getByRole("switch", {
    name: "Telegram request enabled",
  });
  const open = page.getByRole("button", {
    name: "Telegram request",
    exact: true,
  });
  const pane = page.getByRole("dialog");
  const instructions = pane.getByRole("textbox", {
    name: "Instructions (automation.md)",
  });
  await page.goto("./automations");
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  // The fixture's manual automation has no file to write.
  await expect(
    page.getByRole("switch", { name: "Nakara manual enabled" }),
  ).toBeDisabled();

  // The dev project shares the root project's server; only one may edit its files.
  if (testInfo.project.name === "dev") {
    await open.click();
    await expect(pane.getByRole("button", { name: "Run now" })).toBeVisible();
    expect(errors).toEqual([]);
    return;
  }
  const baseURL = testInfo.project.use.baseURL ?? "";
  const path = join(
    smokeDefinitionDir(Number(new URL(baseURL).port)),
    "automations/telegram-request/automation.md",
  );
  const original = await readFile(path, "utf8");
  try {
    await toggle.click();
    await expect(
      page
        .locator(".toast")
        .getByText("Telegram request disabled", { exact: true }),
    ).toBeVisible();
    await expect(toggle).not.toBeChecked();
    expect(await readFile(path, "utf8")).toContain("enabled: false\n---");
    await page.screenshot({
      path: testInfo.outputPath("automations-toggle-desktop.png"),
      fullPage: true,
    });

    await open.click();
    const enabled = pane.getByRole("switch", { name: "Enabled" });
    await expect(enabled).not.toBeChecked();
    await enabled.click();
    await expect(enabled).toBeChecked();
    await expect(toggle).toBeChecked();
    expect(await readFile(path, "utf8")).toContain("enabled: true\n---");

    await instructions.fill(
      "The operator sent this request from Telegram.\n\nReply there.",
    );
    await pane.getByRole("button", { name: "Save instructions" }).click();
    await expect(
      page.locator(".toast").getByText("Instructions saved", { exact: true }),
    ).toBeVisible();
    await expect(
      pane.getByRole("button", { name: "Save instructions" }),
    ).toHaveCount(0);
    expect(await readFile(path, "utf8")).toMatch(
      /enabled: true\n---\nThe operator sent this request from Telegram\.\n\nReply there\.\n$/,
    );

    // A change on disk after the pane loaded is a conflict, not a lost update.
    const onDisk = (await readFile(path, "utf8")).replace(
      "Reply there.",
      "Changed on disk.",
    );
    await writeFile(path, onDisk);
    await instructions.fill("Stale edit.");
    await pane.getByRole("button", { name: "Save instructions" }).click();
    const stale = pane
      .getByRole("alert")
      .filter({ hasText: "changed on disk since this pane was loaded" });
    await expect(stale).toBeVisible();
    expect(await readFile(path, "utf8")).toBe(onDisk);
    await stale.getByRole("button", { name: "Reload" }).click();
    await expect(stale).toHaveCount(0);
    await expect(instructions).toHaveValue(/Changed on disk\.$/);

    // The switch reports a conflict too, with a Reload that lets it switch again.
    await writeFile(path, `${onDisk}Edited again.\n`);
    await toggle.click();
    const refused = page
      .locator(".toast")
      .filter({ hasText: "The switch was not saved" });
    await expect(refused).toBeVisible();
    await expect(toggle).toBeChecked();
    await refused.getByRole("button", { name: "Reload" }).click();
    await expect(instructions).toHaveValue(/Edited again\.$/);
    await toggle.click();
    // The first "disabled" toast may still show, so wait for the switch itself.
    await expect(toggle).not.toBeChecked();
    expect(await readFile(path, "utf8")).toContain("enabled: false\n---");

    // Run now on a disabled automation is refused before it is sent.
    const runNow = pane.getByRole("button", { name: "Run now" });
    await expect(runNow).toBeDisabled();
    await expect(pane).toContainText(
      "Disabled automations do not run. Turn it on to run it now.",
    );
    await page.screenshot({
      path: testInfo.outputPath("automations-run-now-disabled-desktop.png"),
      fullPage: true,
    });
    await enabled.click();
    await expect(runNow).toBeEnabled();

    // An event-triggered automation opens New work on it for the request.
    await runNow.click();
    const modal = page.getByRole("dialog", { name: "New work" });
    await expect(modal.getByLabel("Automation")).toHaveValue(
      "telegram-request",
    );
    await expect(modal.getByLabel("Title")).toHaveValue("");
    await page.screenshot({
      path: testInfo.outputPath("automations-run-now-event-desktop.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);

    // A scheduled automation creates its item at once, as the schedule would.
    await page
      .getByRole("button", { name: "Nightly digest", exact: true })
      .click();
    await expect(
      pane.getByRole("heading", { name: "Nightly digest" }),
    ).toBeVisible();
    await runNow.click();
    await expect(
      page.locator(".toast").getByText(/^Work item #\d+ created$/),
    ).toBeVisible();
    const created = pane.getByRole("link", { name: /Nightly digest \(/ });
    await expect(created).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("automations-run-now-desktop.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(runNow).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("automations-run-now-390.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await created.click();
    await expect(
      page.getByRole("heading", { name: /Nightly digest \(/ }),
    ).toBeVisible();
  } finally {
    await writeFile(path, original);
    await request.post("./api/f/default/definition/reload");
  }
  expect(errors).toEqual([]);
});
