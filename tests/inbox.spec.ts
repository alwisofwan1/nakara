import { expect, type Page, test } from "@playwright/test";

const pill = (page: Page, label: string) =>
  page
    .getByRole("group", { name: "Filter by kind" })
    .getByRole("button", { name: new RegExp(`^${label} \\d+$`) });

test("inbox kinds, filters, side pane actions and mobile layout", async ({
  page,
}, testInfo) => {
  // See tests/server.ts: each project acts on its own items, because root and dev share a server.
  const project = testInfo.project.name;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./inbox");
  await expect(
    page.getByRole("heading", { name: "Inbox", exact: true }),
  ).toBeVisible();
  const rows = page
    .getByRole("list", { name: "Needs you" })
    .getByRole("listitem");
  const row = (title: string) =>
    page.getByRole("button", {
      name: new RegExp(title.replace(/[()]/g, "\\$&")),
    });

  // All four kinds appear.
  await expect(row("Support month and day names in cron")).toContainText(
    "Spec review",
  );
  await expect(row(`Digest question (${project})`)).toContainText("Question");
  await expect(row("Dashboard card for cost per merged PR")).toContainText(
    "PR #10 is ready for review and merge.",
  );
  await expect(row("Smoke test work item")).toContainText("Run failed");
  await expect(row("Smoke test work item")).toContainText(
    "review run #6 failed: Smoke test failure",
  );
  await expect(row("Run limit item")).toContainText("Run limit reached");
  await expect(row("Run limit item")).toContainText(
    "Started 50 of the 50 runs allowed (foreman turns and failed runs included).",
  );

  // Each pill's count matches the rows it shows. Another project may act on
  // the shared server meanwhile, so the count is re-read until both agree.
  for (const label of [
    "Questions",
    "Spec reviews",
    "PR reviews",
    "Failed",
    "All",
  ]) {
    await pill(page, label).click();
    await expect(pill(page, label)).toHaveAttribute("aria-pressed", "true");
    await expect(async () => {
      const text = (await pill(page, label).textContent()) ?? "";
      const count = Number(/(\d+)$/.exec(text)?.[1]);
      expect(count).toBeGreaterThan(0);
      await expect(rows).toHaveCount(count, { timeout: 500 });
    }).toPass();
  }
  await pill(page, "Failed").click();
  await expect(page).toHaveURL(/kind=failed/);
  await expect(row("Smoke test work item")).toBeVisible();
  await expect(row("Dashboard card")).toBeHidden();
  await pill(page, "All").click();

  // A pane only opens for a row the kind filter shows.
  const prPane = page.getByRole("dialog", { name: /Dashboard card/ });
  await row("Dashboard card for cost per merged PR").click();
  await expect(prPane).toBeVisible();
  await pill(page, "Failed").click();
  await expect(page).toHaveURL(/kind=failed.*item=|item=.*kind=failed/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await pill(page, "All").click();
  await expect(prPane).toBeVisible();
  await prPane.getByRole("button", { name: "Close" }).click();
  await expect(prPane).toBeHidden();

  // Acting updates this document; nothing reloads.
  let loads = 0;
  page.on("load", () => {
    loads++;
  });

  // Request changes needs feedback, like the item page form.
  await row(`Cron spec to reject (${project})`).click();
  let pane = page.getByRole("dialog", {
    name: new RegExp(`Cron spec to reject \\(${project}\\)`),
  });
  await expect(pane).toContainText("Spec summary");
  await expect(pane).toContainText("parseCron accepts JAN–DEC");
  await expect(pane).toContainText("Spec #12");
  await expect(pane).toContainText("Recent on this item");
  await expect(pane).toContainText("Foreman: Spec ready for approval.");
  await expect(
    pane.getByRole("link", { name: "Open the spec on GitHub →" }),
  ).toHaveAttribute("href", "https://github.com/alwisofwan1/nakara/pull/12");
  await page.screenshot({
    path: testInfo.outputPath("inbox-spec-desktop.png"),
    fullPage: true,
  });
  await pane.getByRole("button", { name: "Request changes" }).click();
  await expect(pane.getByRole("alert")).toHaveText(
    "Say what should change in the spec.",
  );
  await pane.getByLabel("Feedback").fill("Also accept lowercase names.");
  await pane.getByRole("button", { name: "Request changes" }).click();
  await expect(pane).toBeHidden();
  await expect(page.getByText(/^Changes requested on #\d+\.$/)).toBeVisible();
  await expect(row(`Cron spec to reject (${project})`)).toBeHidden();

  // Approve spec.
  await row(`Cron spec to approve (${project})`).click();
  pane = page.getByRole("dialog", {
    name: new RegExp(`Cron spec to approve \\(${project}\\)`),
  });
  await pane.getByRole("button", { name: "Approve spec" }).click();
  await expect(pane).toBeHidden();
  await expect(page.getByText(/^Spec approved on #\d+\.$/)).toBeVisible();
  await expect(row(`Cron spec to approve (${project})`)).toBeHidden();

  // Answer a question with a quick pick.
  await row(`Digest question (${project})`).click();
  pane = page.getByRole("dialog", {
    name: new RegExp(`Digest question \\(${project}\\)`),
  });
  await expect(pane).toContainText("Which time should the digest go out");
  const pick = pane
    .getByRole("group", { name: "Suggested answers" })
    .getByRole("button", { name: "17:00 UTC every day" });
  await pick.click();
  await expect(pick).toHaveAttribute("aria-pressed", "true");
  await expect(pane.getByLabel("Answer")).toHaveValue("17:00 UTC every day");
  await page.screenshot({
    path: testInfo.outputPath("inbox-question-desktop.png"),
    fullPage: true,
  });
  await pane.getByRole("button", { name: "Send answer" }).click();
  await expect(pane).toBeHidden();
  await expect(page.getByText(/^Answer sent on #\d+\.$/)).toBeVisible();
  await expect(row(`Digest question (${project})`)).toBeHidden();
  expect(loads).toBe(0);

  // A PR and a failure open read-only panes with links to act elsewhere.
  await row("Dashboard card for cost per merged PR").click();
  pane = page.getByRole("dialog", { name: /Dashboard card/ });
  await expect(
    pane.getByRole("link", { name: "Open the PR on GitHub →" }),
  ).toHaveAttribute("href", "https://github.com/alwisofwan1/nakara/pull/10");
  await expect(pane.getByRole("textbox")).toHaveCount(0);
  await pane.getByRole("button", { name: "Close" }).click();
  await expect(pane).toBeHidden();
  await expect(row("Dashboard card for cost per merged PR")).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("inbox-mobile.png"),
    fullPage: true,
  });
  await row("Smoke test work item").click();
  pane = page.getByRole("dialog", { name: /Smoke test work item/ });
  await expect(pane).toContainText("Run failed");
  await pane.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("inbox-pane-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("an empty inbox says nothing needs you", async ({ page }, testInfo) => {
  // The shared fixture always has work waiting, so this page sees an empty inbox.
  await page.route("**/api/inbox", (route) =>
    route.fulfill({
      json: {
        entries: [],
        reach: [],
        lessons: [],
        counts: { all: 0, question: 0, spec: 0, pr: 0, failed: 0 },
      },
    }),
  );
  // A fixed copy: proxying live refetches races the end of the test.
  const status = await (await page.request.get("./api/status")).json();
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { ...status, inbox: 0 } }),
  );
  await page.goto("./inbox");
  await expect(
    page.getByRole("region", { name: "Nothing needs you" }),
  ).toContainText(
    "Spec approvals, questions and ready PRs will show up here and on Telegram.",
  );
  await expect(page.getByRole("group", { name: "Filter by kind" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("link", { name: "Inbox", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("inbox-empty-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("inbox-empty-mobile.png"),
    fullPage: true,
  });
});

test("a proposed lesson is approved with edited lines, or rejected with a reason", async ({
  page,
}) => {
  const lesson = {
    id: 7,
    factory: "default",
    itemId: 1,
    itemTitle: "Lesson item",
    lines: ["Run the tests."],
    mistake: "skipped the tests",
    suggestCheck: true,
    at: "2026-11-25T00:00:00.000Z",
  };
  await page.route("**/api/inbox", (route) =>
    route.fulfill({
      json: {
        entries: [],
        reach: [],
        lessons: [lesson],
        counts: { all: 1, question: 0, spec: 0, pr: 0, failed: 0 },
      },
    }),
  );
  const sent: unknown[] = [];
  await page.route("**/api/lessons/7", (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("./inbox");
  const card = page.getByRole("region", { name: /Proposed lesson/ });
  await expect(card).toContainText("Mistake: skipped the tests");
  await expect(card).toContainText("A lint rule, type or test");
  await expect(card.getByRole("link", { name: "Lesson item" })).toHaveAttribute(
    "href",
    /\/items\/1$/,
  );
  const lines = card.getByLabel(/Lines for every agent/);
  await expect(lines).toHaveValue("Run the tests.");
  await lines.fill("Run npm test.\n\n  Cite the issue.  ");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(
    page.locator(".toast").getByText("Lesson approved.", { exact: true }),
  ).toBeVisible();

  await card.getByLabel("Reason to reject").fill("too vague");
  await card.getByRole("button", { name: "Reject" }).click();
  await expect(
    page.locator(".toast").getByText("Lesson rejected.", { exact: true }),
  ).toBeVisible();
  expect(sent).toEqual([
    { decision: "approve", lines: ["Run npm test.", "Cite the issue."] },
    { decision: "reject", reason: "too vague" },
  ]);
});
