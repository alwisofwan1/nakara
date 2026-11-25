import { expect, type Page, test } from "@playwright/test";

// See tests/server.ts: gh is logged in as smoke-operator with the organization
// acme, and the agent token can't see acme/gadgets. Harbor is a factory already.

const progress = (page: Page) =>
  page.getByRole("progressbar", { name: "Setup progress" });
const next = (page: Page) => page.getByRole("button", { name: "Next" });

test("New factory wizard: code host, repositories and name, kept across a reload", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (/Content.Security.Policy/i.test(message.text()))
      errors.push(message.text());
  });
  await page.goto("./inbox");
  await page
    .locator(".desktop-sidebar")
    .getByRole("link", { name: "New factory" })
    .click();
  await expect(page).toHaveURL(/\/factories\/new\?step=1$/);
  await expect(page).toHaveTitle("New factory · Nakara");
  // Full page: no sidebar or header.
  await expect(page.locator(".desktop-sidebar")).toHaveCount(0);
  await expect(progress(page)).toHaveAttribute(
    "aria-valuetext",
    "Step 1 of 6: Code host",
  );

  // Step 1: gh login, owner, agent token.
  await expect(
    page.getByRole("heading", { name: "Connect your code host" }),
  ).toBeVisible();
  const host = page.getByRole("region", { name: "Code host" });
  await expect(host).toContainText(
    "gh: logged in as smoke-operator (keyring, scopes repo, read:org)",
  );
  await expect(host).toContainText("Connected");
  await expect(page.getByRole("region", { name: "Agent token" })).toContainText(
    "Set · fine-grained",
  );
  const owner = page.getByRole("combobox", { name: "Owner or organization" });
  await expect(owner).toHaveValue("smoke-operator");
  await owner.selectOption("acme");
  await expect(page).toHaveURL(/owner=acme/);
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-1.png"),
    fullPage: true,
  });
  await next(page).click();

  // Step 2: repositories, the agent token's access, and the name.
  await expect(progress(page)).toHaveAttribute(
    "aria-valuetext",
    "Step 2 of 6: Repositories and name",
  );
  const results = page.getByRole("list", { name: "Repositories" });
  await expect(results.getByRole("checkbox")).toHaveCount(3);
  await page.getByRole("textbox", { name: "Search repositories" }).fill("gad");
  await expect(results.getByRole("checkbox")).toHaveCount(1);
  await results.getByRole("checkbox", { name: /acme\/gadgets/ }).check();
  await page.getByRole("textbox", { name: "Search repositories" }).fill("");
  await results.getByRole("checkbox", { name: /acme\/widgets/ }).check();
  const chips = page.getByRole("list", { name: "Selected repositories" });
  await expect(chips.getByRole("listitem")).toHaveText([
    "acme/gadgets",
    "acme/widgets",
  ]);
  // The repository the agent token can't see is flagged before Next.
  const access = page
    .getByRole("alert")
    .filter({ hasText: "Agents can't reach" });
  await expect(access).toContainText("The agent token can't see acme/gadgets.");
  await expect(access).not.toContainText("acme/widgets");

  // A name whose slug exists is rejected.
  const name = page.getByRole("textbox", { name: /Factory name/ });
  await name.fill("Harbor");
  await expect(
    page.getByText(
      'The slug "harbor" is taken by the factory Harbor. Choose another name.',
    ),
  ).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(next(page)).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("wizard-slug-taken.png"),
    fullPage: true,
  });
  await name.fill("Web Shop");
  await expect(page.locator("#factory-name-check")).toHaveText(
    "Slug web-shop · pages at /f/web-shop · foreman @web-shop",
  );
  await page
    .getByRole("textbox", { name: /Description/ })
    .fill("Sells widgets online.");
  await page.getByRole("radio", { name: "#0e7490" }).check();
  await expect(next(page)).toBeEnabled();
  await expect(page).toHaveURL(/color=%230e7490/);
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-2.png"),
    fullPage: true,
  });

  // A reload keeps the step and every choice.
  await page.reload();
  await expect(progress(page)).toHaveAttribute("aria-valuenow", "2");
  await expect(chips.getByRole("listitem")).toHaveText([
    "acme/gadgets",
    "acme/widgets",
  ]);
  await expect(name).toHaveValue("Web Shop");
  await expect(page.getByRole("textbox", { name: /Description/ })).toHaveValue(
    "Sells widgets online.",
  );
  await expect(page.getByRole("radio", { name: "#0e7490" })).toBeChecked();
  await expect(access).toContainText("acme/gadgets");
  await expect(next(page)).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-2-reloaded.png"),
    fullPage: true,
  });

  // Removing the flagged repository clears the warning.
  await chips.getByRole("button", { name: "Remove acme/gadgets" }).click();
  await expect(access).toHaveCount(0);

  await next(page).click();
  await expect(progress(page)).toHaveAttribute("aria-valuenow", "3");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(name).toHaveValue("Web Shop");
  await page.getByRole("button", { name: "Back" }).click();
  await expect(owner).toHaveValue("acme");

  // × returns to the page the wizard was opened from.
  await page.getByRole("button", { name: "Close the wizard" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
  expect(errors).toEqual([]);
});

test("New factory wizard on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./factories/new?step=1");
  await expect(page.getByRole("region", { name: "Code host" })).toContainText(
    "Connected",
  );
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-1-mobile.png"),
    fullPage: true,
  });
  await page.goto(
    `./factories/new?step=2&owner=acme&repos=${encodeURIComponent(
      JSON.stringify(["acme/widgets", "acme/gadgets"]),
    )}&name=Web%20Shop`,
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Agents can't reach" }),
  ).toBeVisible();
  await expect(next(page)).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-2-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("New factory wizard: gh not logged in, then Recheck", async ({
  page,
}, testInfo) => {
  const real = await (await page.request.get("./api/wizard/github")).json();
  let loggedIn = false;
  await page.route("**/api/wizard/github", (route) =>
    route.fulfill({
      json: loggedIn
        ? real
        : {
            login: {
              loggedIn: false,
              account: null,
              detail:
                "You are not logged into any GitHub hosts. Run gh auth login to authenticate.",
            },
            owners: [],
            agentToken: { state: "unset", fineGrained: false },
          },
    }),
  );
  await page.goto("./factories/new");
  const help = page.getByRole("alert").filter({ hasText: "gh auth login" });
  await expect(help).toContainText(
    "gh is not logged in. Run gh auth login on the machine Nakara runs on, then Recheck.",
  );
  // Without an agent token, agents outside Docker use the gh login.
  const token = page.getByRole("region", { name: "Agent token" });
  await expect(token).toContainText("Not set · gh login");
  await expect(token).toContainText(
    "agents running outside Docker push and open PRs with your gh login",
  );
  await expect(next(page)).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("wizard-not-logged-in.png"),
    fullPage: true,
  });
  loggedIn = true;
  await help.getByRole("button", { name: "Recheck" }).click();
  await expect(page.getByRole("region", { name: "Code host" })).toContainText(
    "Connected",
  );
  await expect(next(page)).toBeEnabled();
});

test("New factory wizard: definition, agents, intake, review, and Create with a retried clone", async ({
  page,
}, testInfo) => {
  // Four steps, then a creation job that fails once and is retried.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Each browser project creates its own factory; projects may share a server.
  const project = testInfo.project.name;
  const slug = `shop-${project}`;
  const repos = [`acme/shop-${project}`, `acme/shop-${project}-api`];
  await page.goto(
    `./factories/new?step=2&owner=acme&repos=${encodeURIComponent(
      JSON.stringify(repos),
    )}&name=${encodeURIComponent(`Shop ${project}`)}`,
  );
  await next(page).click();

  // Step 3: the template and where the definition lives.
  await expect(progress(page)).toHaveAttribute(
    "aria-valuetext",
    "Step 3 of 6: Definition source",
  );
  const source = page.getByRole("region", { name: "Definition source" });
  await expect(
    source.getByRole("radio", { name: /Nakara default/ }),
  ).toBeChecked();
  await expect(source).toContainText("Validated");
  await expect(source).toContainText(`/data/factories/${slug}`);
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-3.png"),
    fullPage: true,
  });
  // An import is validated before Next.
  await source.getByRole("radio", { name: /Import existing/ }).check();
  await expect(next(page)).toBeDisabled();
  await source
    .getByRole("textbox", { name: /Folder to import/ })
    .fill("/nonexistent/factory");
  await expect(source.getByRole("alert")).toContainText(
    "/nonexistent/factory is not a folder Nakara can read",
  );
  await expect(next(page)).toBeDisabled();
  // A folder in one of the repositories.
  await source.getByRole("radio", { name: /Nakara default/ }).check();
  await source.getByRole("radio", { name: /A repository folder/ }).check();
  await source
    .getByRole("combobox", { name: "Repository" })
    .selectOption(repos[1] ?? "");
  await expect(source).toContainText(
    `/data/checkouts/acme/shop-${project}-api/factory`,
  );
  await source.getByRole("radio", { name: /Nakara-managed/ }).check();
  await expect(source).toContainText(`/data/factories/${slug}`);
  await expect(next(page)).toBeEnabled();
  await next(page).click();

  // Step 4: the foreman's handle, a toggle and a harness per agent.
  const agents = page.getByRole("region", { name: "Agents" });
  await expect(
    agents.getByRole("textbox", { name: /call your foreman/ }),
  ).toHaveAttribute("placeholder", slug);
  await expect(agents.getByRole("switch")).toHaveCount(6);
  await expect(
    agents.getByRole("switch", { name: "Implement enabled" }),
  ).toBeDisabled();
  await expect(
    agents.getByRole("switch", { name: "Implement enabled" }),
  ).toBeChecked();
  await agents.getByRole("switch", { name: "Triage enabled" }).uncheck();
  await agents
    .getByRole("combobox", { name: "Review harness" })
    .selectOption("codex");
  await agents
    .getByRole("textbox", { name: /call your foreman/ })
    .fill("Bad Handle");
  await expect(next(page)).toBeDisabled();
  await agents
    .getByRole("textbox", { name: /call your foreman/ })
    .fill(`${slug}-bot`);
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-4.png"),
    fullPage: true,
  });
  await next(page).click();

  // Step 5: intake; web is always on, Slack and Linear are not there yet.
  const intake = page.getByRole("region", { name: "Intake" });
  await expect(
    intake.getByRole("switch", { name: "GitHub issues" }),
  ).toBeChecked();
  // Telegram reaches the default factory only, until per-factory routing.
  await expect(intake.getByRole("switch", { name: "Telegram" })).toBeDisabled();
  await expect(intake).toContainText("Default factory only (not yet)");
  await expect(intake).toContainText("Always on");
  await expect(intake).toContainText("Not yet");
  await intake.getByRole("switch", { name: "Schedule" }).check();
  await expect(
    intake.getByRole("textbox", { name: "Cron schedule (UTC)" }),
  ).toHaveValue("0 6 * * 1");
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-5.png"),
    fullPage: true,
  });
  await next(page).click();

  // Step 6: the summary with Edit links, and the files to write.
  const summary = page.getByRole("region", { name: "Summary" });
  await expect(summary).toContainText(`Shop ${project} · @${slug}-bot`);
  await expect(summary).toContainText(
    "foreman (claude), spec (claude), implement (claude), review (codex)",
  );
  await expect(summary).toContainText(
    `GitHub label factory:Shop ${project}, Schedule 0 6 * * 1, Web`,
  );
  const files = summary.getByRole("list", { name: "Files to write" });
  await expect(files).toContainText("factory.yaml");
  await expect(files).toContainText("automations/scheduled/automation.md");
  await expect(files).not.toContainText("agents/triage/agent.md");
  await page.screenshot({
    path: testInfo.outputPath("wizard-step-6.png"),
    fullPage: true,
  });
  await summary.getByRole("button", { name: "Edit agents" }).click();
  await expect(progress(page)).toHaveAttribute("aria-valuenow", "4");
  await next(page).click();
  await expect(progress(page)).toHaveAttribute("aria-valuenow", "5");
  await next(page).click();
  await expect(summary).toBeVisible();
  // Nothing was written before Create.
  const before = await (await page.request.get("./api/factories")).json();
  expect(before.map((f: { slug: string }) => f.slug)).not.toContain(slug);

  // Create: the first clone of the -api repository fails.
  await page.getByRole("button", { name: "Create factory" }).click();
  const steps = page.getByRole("region", { name: "Creation progress" });
  await expect(
    steps.getByRole("listitem", { name: "Clone repositories: failed" }),
  ).toContainText("Could not resolve host: github.com");
  await expect(
    steps.getByRole("listitem", { name: "Write definition: done" }),
  ).toContainText("files in");
  await expect(
    steps.getByRole("listitem", { name: "Validate: done" }),
  ).toContainText("0 errors");
  await expect(
    steps.getByRole("listitem", { name: "Create labels: pending" }),
  ).toBeVisible();
  const job = new URL(page.url()).searchParams.get("job");
  expect(job).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("wizard-create-failed.png"),
    fullPage: true,
  });

  // Retry resumes at the clone; the factory's Activity opens with New work.
  await steps.getByRole("button", { name: "Retry" }).click();
  await expect(page).toHaveURL(new RegExp(`/f/${slug}/activity\\?new=1$`));
  await expect(page.getByRole("dialog", { name: "New work" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("wizard-created.png"),
    fullPage: true,
  });
  // The new factory is listed in the sidebar behind the dialog.
  await page.keyboard.press("Escape");
  await expect(
    page
      .locator(".desktop-sidebar")
      .getByRole("group", { name: `Shop ${project}` }),
  ).toBeVisible();
  const done = await (
    await page.request.get(`./api/wizard/creations/${job}`)
  ).json();
  expect(
    done.steps.map((s: { status: string; detail: string }) => [
      s.status,
      s.detail,
    ]),
  ).toEqual([
    ["done", expect.stringMatching(/^\d+ files in .+\/factories\/shop-/)],
    ["done", "0 errors"],
    ["done", "2 of 2"],
    ["done", `factory:Shop ${project}: 1 created, 1 already existed`],
    ["done", "GitHub poll, Schedule, Web"],
  ]);
  expect(errors).toEqual([]);
});

test("New factory wizard: after a failed Create, change the choices and Create again in the same folder", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const project = testInfo.project.name;
  const slug = `again-${project}`;
  // The first clone of the -api repository fails (see tests/server.ts).
  const repos = [`acme/again-${project}`, `acme/again-${project}-api`];
  await page.goto(
    `./factories/new?step=6&owner=acme&repos=${encodeURIComponent(
      JSON.stringify(repos),
    )}&name=${encodeURIComponent(`Again ${project}`)}`,
  );
  await page.getByRole("button", { name: "Create factory" }).click();
  const steps = page.getByRole("region", { name: "Creation progress" });
  await expect(
    steps.getByRole("listitem", { name: "Clone repositories: failed" }),
  ).toBeVisible();
  const failed = new URL(page.url()).searchParams.get("job");

  // Back to Review, turn review off, and Create again: the folder the
  // failed attempt wrote is reused instead of refused.
  await steps.getByRole("button", { name: "Change choices" }).click();
  const summary = page.getByRole("region", { name: "Summary" });
  await summary.getByRole("button", { name: "Edit agents" }).click();
  await page.getByRole("switch", { name: "Review enabled" }).uncheck();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(progress(page)).toHaveAttribute("aria-valuenow", "5");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(summary).toContainText(
    "foreman (claude), triage (claude), spec (claude), implement (claude)",
  );
  await expect(
    summary.getByRole("list", { name: "Files to write" }),
  ).not.toContainText("agents/review/agent.md");
  await page.getByRole("button", { name: "Create factory" }).click();
  await expect(page).toHaveURL(new RegExp(`/f/${slug}/activity\\?new=1$`));
  // The failed attempt was replaced by the new one.
  expect(
    (await page.request.get(`./api/wizard/creations/${failed}`)).status(),
  ).toBe(404);
});

test("New factory wizard steps 3 to 6 on a phone", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const base = `./factories/new?owner=acme&repos=${encodeURIComponent(
    JSON.stringify(["acme/sprockets"]),
  )}&name=Phone%20Shop&location=repo&off=${encodeURIComponent(
    JSON.stringify(["review"]),
  )}`;
  for (const [step, region] of [
    [3, "Definition source"],
    [4, "Agents"],
    [5, "Intake"],
    [6, "Summary"],
  ] as const) {
    await page.goto(`${base}&step=${step}`);
    await expect(page.getByRole("region", { name: region })).toBeVisible();
    if (step === 3)
      await expect(
        page.getByRole("region", { name: "Definition source" }),
      ).toContainText("Written to");
    if (step === 6)
      await expect(
        page.getByRole("list", { name: "Files to write" }),
      ).toContainText("factory.yaml");
    await page.screenshot({
      path: testInfo.outputPath(`wizard-step-${step}-mobile.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});
