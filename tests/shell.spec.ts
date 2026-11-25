import { expect, type Page, test } from "@playwright/test";

test("a stale backup is flagged in the footer and the shell", async ({
  page,
}, testInfo) => {
  const status = await (await page.request.get("./api/status")).json();
  const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { ...status, backup: { at, intervalHours: 24 } } }),
  );
  await page.goto("./activity");
  await expect(page.locator("footer")).toContainText("Backup · 3d ago · Stale");
  // Lighthouse's banner (a broken fixture factory) is covered by factories.spec.ts.
  await expect(
    page.getByRole("alert").filter({ hasNotText: "Lighthouse" }),
  ).toHaveText(
    "The last backup is from 3d ago, older than twice the 24 h interval. See the server log.",
  );
  await page.screenshot({
    path: testInfo.outputPath("stale-backup.png"),
    fullPage: true,
  });
});

test("Activity shows what closed work came to, and nothing before a PR closes", async ({
  page,
}, testInfo) => {
  const live = await (await page.request.get("./api/f/default/items")).json();
  let outcomes = {
    prs: 62,
    merged: 61,
    closedUnmerged: 1,
    revisionsPerItem: 1.03,
    costPerMergedPrUsd: 10.762,
    medianCycleHours: 1.73,
  };
  await page.route("**/api/f/default/items", (route) =>
    route.fulfill({ json: { ...live, outcomes } }),
  );
  await page.goto("./activity");
  const strip = page.getByRole("region", { name: "Outcomes" });
  const tiles: [string, string, string][] = [
    ["Merge rate", "98%", "61 of 62 PRs"],
    ["Closed unmerged", "1", "PRs closed without a merge"],
    ["Revisions per item", "1.0", "after review"],
    ["Cost per merged PR", "$10.76", "all closed work ÷ merged"],
    ["Median cycle time", "1.7 h", "request → merge"],
  ];
  for (const [label, value, note] of tiles)
    await expect(
      strip.locator("dl > div").filter({ hasText: label }),
    ).toHaveText(
      new RegExp(`${label}\\s*${value.replace("$", "\\$")}\\s*${note}`),
    );
  await page.screenshot({
    path: testInfo.outputPath("outcomes.png"),
    fullPage: true,
  });

  outcomes = {
    prs: 0,
    merged: 0,
    closedUnmerged: 0,
    revisionsPerItem: null,
    costPerMergedPrUsd: null,
    medianCycleHours: null,
  } as unknown as typeof outcomes;
  await page.reload();
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  await expect(strip).toBeHidden();
});

test("a page that fails to render shows its error inside the shell", async ({
  page,
}) => {
  // A malformed run makes the run page throw while rendering.
  await page.route(/\/api\/runs\/\d+$/, (route) => route.fulfill({ json: {} }));
  await page.goto("./runs/1");
  await expect(
    page.getByRole("region", { name: "This page failed to load" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /^Inbox/ })).toBeVisible();
  await expect(page).toHaveTitle("Error · Default · Nakara");
});

test("shell, live status, legacy navigation and mobile menu", async ({
  page,
}, testInfo) => {
  // One long walk through the shell; on the vite dev server it takes ~30s.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The server's Content-Security-Policy reports blocked resources only here.
  page.on("console", (message) => {
    if (/Content.Security.Policy/i.test(message.text()))
      errors.push(message.text());
  });
  const events = page.waitForResponse((response) =>
    response.url().endsWith("/api/events"),
  );
  await page.goto("./");
  // Factory pages live under /f/<slug>/; the fixture's only factory is "default".
  await expect(page).toHaveURL(/\/f\/default\/activity$/);
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Activity · Default · Nakara");
  await expect(page.locator("footer")).toContainText("Slots · 1/2 busy");
  expect((await events).headers()["content-type"]).toContain(
    "text/event-stream",
  );
  // The fixture snapshots the database at startup; the suite runs for minutes.
  await expect(page.locator("footer")).toContainText(
    /Backup · (just now|\d+m ago)(?! · Stale)/,
  );
  await expect(
    page.getByRole("alert").filter({ hasNotText: "Lighthouse" }),
  ).toHaveCount(0);
  const time = page
    .locator("footer div")
    .filter({ hasText: "GitHub poll" })
    .locator("time");
  await expect(time).toHaveAttribute("datetime", /T/);
  const firstPoll = await time.getAttribute("datetime");
  // A changed timestamp in this document proves query invalidation, not a reload.
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await expect(time).not.toHaveAttribute("datetime", firstPoll ?? "", {
    timeout: 5000,
  });
  expect(navigations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("desktop.png"),
    fullPage: true,
  });
  await activity(page);
  // Gone after a full page load: the links below must navigate in place.
  await page.evaluate(() => {
    (window as { inPlace?: boolean }).inPlace = true;
  });
  await page.getByRole("link", { name: /^Inbox/ }).click();
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Smoke test work item/ }).click();
  await page.getByRole("link", { name: "View work item →" }).click();
  await expect(
    page.getByRole("heading", { name: /Smoke test work item/ }),
  ).toBeVisible();
  await page.getByRole("link", { name: /implement.*succeeded/ }).click();
  await expect(
    page.getByRole("heading", { name: "implement · claude" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: /Smoke test work item/ })
    .click();
  await expect(
    page.getByRole("heading", { name: /Smoke test work item/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as { inPlace?: boolean }).inPlace),
  ).toBe(true);
  // Old factory page links open the first factory's page.
  await page.goto("./definition");
  await expect(page).toHaveURL(/\/f\/default\/definition$/);
  await expect(
    page.getByRole("heading", { name: "Factory definition", exact: true }),
  ).toBeVisible();
  await page.goto("./agents/review");
  await expect(page).toHaveURL(/\/f\/default\/agents\/review$/);
  await expect(
    page.getByRole("heading", { name: "review", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
      name: "Default",
    }),
  ).toHaveAttribute("href", /\/f\/default\/activity$/);
  await page.screenshot({
    path: testInfo.outputPath("legacy-agent-link.png"),
    fullPage: true,
  });
  await page.goto("./future/deep");
  await expect(
    page.getByText("Page not found.", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Page not found · Default · Nakara");
  await expect(page.locator("footer")).toContainText("Slots · 1/2 busy");
  await expect(page.locator(".desktop-sidebar")).toHaveCSS("width", "240px");
  await page.goto("./");
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole("button", { name: "Open navigation menu" });
  await expect(trigger).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Navigation" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("footer")).toContainText("Slots · 1/2 busy");
  await page.screenshot({
    path: testInfo.outputPath("mobile-menu.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("group", { name: "Default" })
    .getByRole("link", { name: "Activity", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

async function activity(page: Page) {
  const group = (name: string) => page.getByRole("region", { name });
  const header = (name: string) =>
    page.getByRole("button", { name: new RegExp(`^${name} \\d+$`) });
  for (const name of ["Triage", "Planning", "Building"])
    await expect(header(name)).toHaveAttribute("aria-expanded", "true");
  await expect(header("Complete")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Weekly health check")).toBeHidden();
  await header("Complete").click();
  await expect(group("Complete")).toContainText("Weekly health check");
  await expect(group("Complete")).toContainText("weekly-health-check");
  await header("Planning").click();
  await expect(header("Planning")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Support month and day names")).toBeHidden();
  await header("Planning").click();
  const spec = page.getByRole("listitem").filter({
    hasText: "Support month and day names in cron",
  });
  await expect(spec).toContainText("Spec needs approval");
  await expect(spec).toContainText("Spec #12");
  await expect(spec).toContainText("nakara#5");
  await expect(spec).toContainText("$1.12");
  const smoke = page
    .getByRole("listitem")
    .filter({ hasText: "Smoke test work item" });
  await expect(smoke).toContainText("Manual");
  await expect(smoke).not.toContainText("Spec needs approval");

  await page.getByRole("button", { name: "Source: all" }).click();
  await page.getByRole("menuitemradio", { name: "Telegram" }).click();
  await expect(page).toHaveURL(/source=telegram/);
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(group("Building")).toContainText("Daily digest");
  await page.getByRole("button", { name: "Source: Telegram" }).click();
  await page.getByRole("menuitemradio", { name: "All sources" }).click();
  // Other specs add items to the shared fixture, so rows are found by content.
  await expect(smoke).toBeVisible();
  await expect(group("Building")).toContainText("Daily digest");

  const hide = page.getByRole("button", { name: "Hide complete" });
  await hide.click();
  await expect(hide).toHaveAttribute("aria-pressed", "true");
  await expect(header("Complete")).toBeHidden();
  await expect(page.getByText("Weekly health check")).toBeHidden();
  await expect(spec).toBeVisible();
  await hide.click();
  await expect(header("Complete")).toBeVisible();
}

test("automations table, details, work item links and mobile layout", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./automations");
  await expect(
    page.getByRole("heading", { name: "Automations", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(7);
  await expect(
    page.getByText("github · issue labeled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Slack request enabled" }),
  ).not.toBeChecked();
  await expect(
    page.getByText("telegram · message", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("cron · 0 2 * * 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "Weekly health check" }),
  ).toContainText("UTC");
  await expect(
    page.getByRole("switch", { name: "Weekly health check enabled" }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("switch", { name: "issue-labeled enabled" }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("automations-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "issue-labeled", exact: true })
    .click();
  const pane = page.getByRole("dialog");
  await expect(
    pane.getByRole("heading", {
      name: "Instructions (automation.md)",
      exact: true,
    }),
  ).toBeVisible();
  await expect(pane).toContainText("factory:Nakara");
  await expect(pane).toContainText("Settings");
  await page.screenshot({
    path: testInfo.outputPath("automations-desktop-pane.png"),
    fullPage: true,
  });
  await pane.getByRole("link", { name: /Smoke test work item/ }).click();
  await expect(
    page.getByRole("heading", { name: /Smoke test work item/ }),
  ).toBeVisible();
  await page.goto("./automations");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "issue-labeled", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("automations-390.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "issue-labeled", exact: true })
    .click();
  await expect(pane).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("automations-390-pane.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(pane).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("agents tree and detail tabs", async ({ page }, testInfo) => {
  await page.goto("./agents");
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
  const cards = page.locator(".agent-card");
  await expect(cards.first()).toContainText("foreman");
  // The definition spec creates and deletes an agent on the same server, so the
  // shipped agents are checked by name rather than by count.
  for (const name of ["implement", "review", "spec", "triage"])
    await expect(
      page.locator(".agent-child .agent-name > strong", { hasText: name }),
    ).toHaveText(name);
  await expect(page.getByRole("link", { name: "+ New agent" })).toHaveAttribute(
    "href",
    /\/agents\/new$/,
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: testInfo.outputPath(`agents-${width}.png`),
      fullPage: true,
    });
  }
  await cards.first().click();
  await expect(page.getByRole("textbox", { name: "Prompt" })).toHaveValue(
    /^# Foreman/,
  );
  await page.getByRole("tab", { name: "Automations", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("issue-labeled");
  await page.screenshot({
    path: testInfo.outputPath("automations-390.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  const runner = page.getByRole("combobox", { name: "Runner" });
  await expect(runner).toHaveValue("");
  await expect(runner.locator("option:checked")).toHaveText("Default (docker)");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: testInfo.outputPath(`settings-${width}.png`),
      fullPage: true,
    });
  }
  await page.goto("./agents/implement");
  await page.getByRole("tab", { name: "Runs", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("Run #1");
  await expect(page.getByRole("tabpanel")).toContainText("succeeded");
  await page.screenshot({
    path: testInfo.outputPath("runs-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Automations", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText(
    "No automations use this agent.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("runs page filters, live duration and row links", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Runs", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Runs", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Breadcrumb")).toContainText("Runs");
  // Other specs add runs to the shared fixture, so rows are found by content.
  const rows = page.locator("main li");
  const liveRow = rows.filter({ hasText: "Live run item" });
  const reviewRow = rows
    .filter({ hasText: "Smoke test work item" })
    .filter({ hasText: "review run #" });
  const smokeRow = rows
    .filter({ hasText: "Smoke test work item" })
    .filter({ hasText: "implement run #" });
  await expect(liveRow).toHaveCount(1);
  await expect(liveRow).toContainText("foreman run #");
  await expect(liveRow).toContainText("claude · sonnet");
  await expect(reviewRow).toHaveCount(1);
  await expect(reviewRow).toContainText("$0.42");
  await expect(reviewRow).toContainText("1m 5s");

  // The running row's duration counts up in place, without a reload.
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  const duration = liveRow.locator("dd time").first();
  const before = await duration.getAttribute("datetime");
  await expect(duration).not.toHaveAttribute("datetime", before ?? "", {
    timeout: 5000,
  });
  expect(navigations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("runs-desktop.png"),
    fullPage: true,
  });

  const status = page.getByRole("navigation", { name: "Filter by status" });
  await status.getByRole("link", { name: "Running", exact: true }).click();
  await expect(page).toHaveURL(/status=running/);
  await expect(liveRow).toHaveCount(1);
  await expect(reviewRow).toHaveCount(0);
  await expect(smokeRow).toHaveCount(0);
  await page.getByLabel("Agent").selectOption("implement");
  await expect(page).toHaveURL(
    /status=running.*agent=implement|agent=implement.*status=running/,
  );
  await expect(page.getByText("No runs match these filters.")).toBeVisible();
  await status.getByRole("link", { name: "Succeeded", exact: true }).click();
  await expect(smokeRow).toHaveCount(1);
  await expect(liveRow).toHaveCount(0);
  await expect(page.getByLabel("Agent")).toHaveValue("implement");
  await status.getByRole("link", { name: "All", exact: true }).click();
  await expect(smokeRow).toHaveCount(1);
  await expect(reviewRow).toHaveCount(0);
  await page.getByLabel("Agent").selectOption("");
  await expect(reviewRow).toHaveCount(1);
  await expect(liveRow).toHaveCount(1);

  await smokeRow.getByRole("link", { name: /Smoke test work item/ }).click();
  await expect(
    page.getByRole("heading", { name: /Smoke test work item/ }),
  ).toBeVisible();
  await page.goBack();
  await smokeRow.getByRole("link", { name: /implement run #/ }).click();
  await expect(
    page.getByRole("heading", { name: /^implement · / }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./runs");
  await expect(liveRow).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("runs-mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
