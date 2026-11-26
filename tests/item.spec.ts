import { expect, type Page, test } from "@playwright/test";

/** Fixture items are found by title: other specs add items to the shared server. */
async function itemId(page: Page, title: string): Promise<number> {
  const response = await page.request.get("./api/f/default/items");
  const { items } = (await response.json()) as {
    items: { id: number; title: string }[];
  };
  const item = items.find((i) => i.title === title);
  if (!item) throw new Error(`Missing fixture item: ${title}`);
  return item.id;
}

const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

test("work item page: progress, conversation, properties and spec approval", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./activity");
  let loads = 0;
  page.on("load", () => loads++);
  await page
    .getByRole("link", { name: "Support month and day names in cron" })
    .click();
  await expect(page).toHaveURL(/\/items\/\d+$/);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /Support month and day names in cron/,
    }),
  ).toBeVisible();
  expect(loads).toBe(0);
  await expect(page.getByLabel("Breadcrumb")).toContainText("Activity");

  const progress = page.getByRole("list", { name: "Stage progress" });
  await expect(progress.locator('[aria-current="step"]')).toHaveText(
    "Spec approval",
  );

  const conversation = page.getByRole("region", { name: "Conversation" });
  // The item's request opens the conversation, from its requester.
  const request = conversation.getByRole("article").first();
  await expect(request).toContainText("alwisofwan1");
  await expect(request).toContainText("Support JAN–DEC and SUN–SAT");
  await expect(conversation).toContainText("Foreman");
  const triage = conversation
    .getByRole("article")
    .filter({ hasText: "triage · claude opus" });
  await expect(triage).toContainText("parseCron throws on MON");
  await expect(triage).toContainText("Succeeded");
  await expect(triage.getByRole("link", { name: "View log →" })).toBeVisible();

  const card = page.getByRole("region", { name: "Action" });
  await expect(card).toContainText("Waiting for you: approve Spec #12");
  await expect(
    card.getByRole("button", { name: "Approve spec" }),
  ).toBeEnabled();
  await card.getByRole("button", { name: "Request changes" }).click();
  await expect(card.getByLabel("What should change")).toBeVisible();
  await card.getByRole("button", { name: "Back" }).click();

  const properties = page.getByRole("complementary", { name: "Properties" });
  await expect(properties).toContainText("Spec needs approval");
  await expect(properties).toContainText("GitHub issue");
  await expect(
    properties.getByRole("link", { name: "Issue nakara#5" }),
  ).toHaveAttribute("href", "https://github.com/alwisofwan1/nakara/issues/5");
  await expect(
    properties.getByRole("link", { name: "Spec #12" }),
  ).toHaveAttribute("href", "https://github.com/alwisofwan1/nakara/pull/12");
  // $1.12 of the $15.00 budget: the bar is 7.5% full.
  await expect(properties).toContainText("$1.12 of $15.00");
  await expect(properties).toContainText("7%");
  const bar = properties.locator("[data-ratio] > div");
  const [used, track] = await Promise.all([
    bar.evaluate((el) => el.getBoundingClientRect().width),
    bar.evaluate((el) => el.parentElement?.getBoundingClientRect().width ?? 0),
  ]);
  expect(used / track).toBeCloseTo(1.12 / 15, 2);
  await expect(properties.getByRole("listitem")).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("work item page renders each state's action card", async ({
  page,
}, testInfo) => {
  // Eight states, each with a full-page screenshot.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  type State = {
    title: string;
    name: string;
    expected: (string | RegExp)[];
    disabled?: string[];
    enabled?: string[];
  };
  const states: State[] = [
    {
      title: "Retry the last agent",
      name: "question",
      expected: ["Foreman asks", "should retry re-run review", "Send answer"],
    },
    {
      title: "Verify the retry flow",
      name: "building",
      expected: [
        "verify · codex",
        /Running \d/,
        "✓ retry.test.ts (4)",
        "Open run",
      ],
      enabled: ["Stop run"],
    },
    {
      title: "Retry failed work items",
      name: "handoff",
      expected: [
        "PR #14 ready for review",
        "feat: retry failed work items",
        "acme/widgets · nakara/item-23 → main · +184 −22 · checks passing on 9f3c2a1",
        "Open PR on GitHub",
      ],
      enabled: ["Merge PR #14", "Request changes"],
    },
    {
      title: "Budget exhausted item",
      name: "failed",
      expected: ["Budget exhausted", "$15.00 of $15.00", "Raise budget +$10"],
      // No failed run to retry: only the budget blocks this item.
      enabled: ["Raise budget +$10", "Cancel item"],
    },
    {
      title: "Run limit item",
      name: "run-limit",
      expected: [
        "Run limit reached",
        "$0.00 of $15.00",
        "50 of 50 runs",
        "Raise run limit +10",
      ],
      enabled: ["Raise run limit +10", "Raise budget +$10", "Cancel item"],
    },
    {
      title: "Smoke test work item",
      name: "run-failed",
      expected: ["Run failed", "last run review failed", "Smoke test failure"],
      enabled: ["Retry", "Raise budget +$10"],
    },
    {
      title: "Weekly health check",
      name: "complete",
      expected: ["Completed", "Cost", "Runs", "Revisions", "1 round · passed"],
    },
    {
      title: "Cancelled item",
      name: "cancelled",
      expected: ["Cancelled", "Cancelling is final", "Duplicate as new work"],
      enabled: ["Duplicate as new work"],
    },
  ];
  // Client-side navigation only: the dev project would rebuild every module on a reload.
  await page.goto("./activity");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  for (const { title, name, expected, disabled = [], enabled = [] } of states) {
    const link = page.getByRole("link", { name: title, exact: true });
    const complete = page.getByRole("button", { name: /^Complete \d+$/ });
    await expect(complete).toBeVisible();
    if ((await complete.getAttribute("aria-expanded")) === "false")
      await complete.click();
    await link.click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
    const card = page.getByRole("region", { name: "Action" });
    for (const text of expected) await expect(card).toContainText(text);
    for (const label of disabled)
      await expect(card.getByRole("button", { name: label })).toBeDisabled();
    for (const label of enabled)
      await expect(card.getByRole("button", { name: label })).toBeEnabled();
    if (name === "cancelled" || name === "complete")
      await expect(page.getByLabel("Message the factory")).toHaveCount(0);
    else await expect(page.getByLabel("Message the factory")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`state-${name}.png`),
      fullPage: true,
    });
    // The run count sits next to the budget in the item's properties.
    if (name === "run-limit")
      await expect(page.getByText("50 of 50", { exact: true })).toBeVisible();
    if (name === "failed" || name === "run-failed" || name === "run-limit") {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(card).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`state-${name}-mobile.png`),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await sidebar
      .getByRole("group", { name: "Default" })
      .getByRole("link", { name: "Activity", exact: true })
      .click();
  }
  expect(errors).toEqual([]);
});

test("request changes on a handed-off PR and the composer message the foreman", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const project = testInfo.project.name;
  await page.goto(`./items/${await itemId(page, "Retry failed work items")}`);
  let loads = 0;
  page.on("load", () => loads++);
  const card = page.getByRole("region", { name: "Action" });
  await card.getByRole("button", { name: "Request changes" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Request changes on PR #14",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Feedback/).fill(`Rename the flag (${project})`);
  await page.screenshot({ path: testInfo.outputPath("request-changes.png") });
  await dialog.getByRole("button", { name: "Send feedback" }).click();
  await expect(dialog).toBeHidden();
  const conversation = page.getByRole("region", { name: "Conversation" });
  await expect(
    conversation
      .getByRole("article")
      .filter({ hasText: `Rename the flag (${project})` }),
  ).toContainText("Changes requested on PR #14:");

  const composer = page.getByLabel("Message the factory");
  await composer.fill(`Also update the docs (${project})`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveValue("");
  await expect(conversation).toContainText(`Also update the docs (${project})`);
  expect(loads).toBe(0);
  expect(errors).toEqual([]);
});

test("a missing work item, run or agent shows Page not found", async ({
  page,
}) => {
  for (const path of [
    "./items/999999",
    "./items/abc",
    "./runs/999999",
    "./runs/abc",
    "./f/default/agents/nobody",
  ]) {
    await page.goto(path);
    await expect(
      page.getByText("Page not found.", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle("Page not found · Default · Nakara");
  }
});

for (const recovery of ["Try again", "the live stream reconnecting"]) {
  test(`a work item that failed to load comes back with ${recovery}`, async ({
    page,
  }) => {
    const id = await itemId(page, "Retry failed work items");
    const api = /\/api\/items\/\d+$/;
    const events = /\/api\/events$/;
    await page.route(api, (route) =>
      route.fulfill({ status: 500, json: { error: { message: "Down" } } }),
    );
    // The stream reloads failed pages when it connects; keep it down until the API is back.
    await page.route(events, (route) => route.abort());
    await page.goto(`./items/${id}`);
    const failed = page.getByRole("region", {
      name: "This page failed to load",
    });
    // A server error is retried three times (about 7 s) before the page fails.
    await expect(failed).toContainText("Down", { timeout: 15_000 });
    await page.unroute(api);
    if (recovery === "Try again")
      await failed.getByRole("button", { name: "Try again" }).click();
    else await page.unroute(events);
    await expect(
      page.getByRole("heading", { name: /Retry failed work items/ }),
    ).toBeVisible();
  });
}
