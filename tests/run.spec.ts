import { appendFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const assistant = (text: string) =>
  `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`;

test("run page streams the log live, ends cleanly and queues a follow-up", async ({
  page,
}, testInfo) => {
  // See tests/server.ts: each project gets its own item, because root and dev share a server.
  const [agentRun, liveRun] = testInfo.project.name === "dev" ? [4, 5] : [2, 3];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`./runs/${liveRun}`);
  await expect(
    page.getByRole("heading", { name: "Foreman turn · claude:opus" }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }),
  ).toContainText(`Run #${liveRun}`);
  const log = page.getByRole("log", { name: "Run log" });
  await expect(log).toContainText("Reading the request.");
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  const footer = await page.getByText(/raw log: /).textContent();
  const logPath = footer?.split("raw log: ")[1]?.trim() ?? "";
  expect(logPath).toMatch(/\.jsonl$/);

  // New bytes reach this document over SSE; nothing reloads. (Client-side
  // route changes fire framenavigated, but only a document load fires "load".)
  let loads = 0;
  page.on("load", () => {
    loads++;
  });
  appendFileSync(logPath, assistant("Streaming a new line."));
  await expect(log).toContainText("Streaming a new line.");
  await page.screenshot({
    path: testInfo.outputPath("run-live-desktop.png"),
    fullPage: true,
  });
  appendFileSync(logPath, assistant("SMOKE_FINISH"));
  await expect(page.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Run ended/)).toBeVisible();
  await expect(log).toContainText("SMOKE_FINISH");
  await page.getByRole("tab", { name: "Report" }).click();
  await expect(page.getByRole("tabpanel")).toContainText(
    "Dispatched implement.",
  );
  expect(loads).toBe(0);

  // Other runs on the item are linked, and a follow-up queues into the agent's session.
  await page
    .getByRole("complementary", { name: "Run actions" })
    .getByRole("link", { name: /implement · claude/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "implement · claude" }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/runs/${agentRun}$`));
  await expect(page.getByText("Build the smoke feature")).toBeVisible();
  await expect(
    page.getByText(/Counts as a revision \(0 of 2 used\)/),
  ).toBeVisible();
  await page
    .getByLabel("Follow-up message")
    .fill("Also add a test for the retry path.");
  await page.getByRole("button", { name: "Queue follow-up" }).click();
  await expect(page.getByText(/^Queued as run #\d+/)).toBeVisible();
  await expect(page.getByText(/already queued/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Queue follow-up" }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("run-follow-up-desktop.png"),
    fullPage: true,
  });
  expect(loads).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`./runs/${liveRun}`);
  await expect(log).toContainText("SMOKE_FINISH");
  await page.screenshot({
    path: testInfo.outputPath("run-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("run Diff tab shows the git diff per repository, or the log's edits for runs without snapshots", async ({
  page,
}, testInfo) => {
  // See tests/server.ts: the agent run's worktrees were snapshotted around a
  // sed edit in widgets and a large generated file in gadgets.
  const [agentRun, liveRun] = testInfo.project.name === "dev" ? [4, 5] : [2, 3];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`./runs/${agentRun}`);
  await page.getByRole("tab", { name: "Diff" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel).toContainText(
    "What this run changed in its worktrees, committed or not, by any tool.",
  );
  const widgets = panel.getByRole("region", { name: "acme/widgets" });
  await expect(widgets).toContainText(
    "1 file changed, 1 insertion(+), 1 deletion(-)",
  );
  await expect(widgets).toContainText("config.yaml (modified)");
  await expect(widgets.getByText("-color: red")).toBeVisible();
  await expect(widgets.getByText("+color: blue")).toBeVisible();
  await expect(widgets.getByRole("note")).toHaveCount(0);
  const gadgets = panel.getByRole("region", { name: "acme/gadgets" });
  await expect(gadgets).toContainText("generated.txt (added)");
  await expect(gadgets).toContainText("20000 insertions(+)");
  await expect(gadgets.getByRole("note")).toHaveText(
    "Diff truncated: only the first 256 KB are shown. The summary above counts every change.",
  );
  await page.screenshot({
    path: testInfo.outputPath("run-diff-desktop.png"),
    fullPage: true,
  });

  // A foreman turn records no snapshots: the log-based view and its notice.
  await page.goto(`./runs/${liveRun}`);
  await page.getByRole("tab", { name: "Diff" }).click();
  await expect(page.getByRole("tabpanel")).toHaveText(
    "No file edits were recorded in this run's log.",
  );

  // A run without snapshots whose log records an edit: that edit, under the log notice.
  const runs = await (await page.request.get("./api/runs")).json();
  const harbor = runs.runs.find(
    (r: { itemTitle: string }) => r.itemTitle === "Harbor tide table import",
  );
  await page.goto(`./runs/${harbor.id}`);
  await page.getByRole("tab", { name: "Diff" }).click();
  const fallback = page.getByRole("tabpanel");
  await expect(fallback).toContainText(
    "File edits recorded in this run's log, not a git diff. Changes made by shell commands do not appear here.",
  );
  await expect(fallback).toContainText("src/tides.ts (edit)");
  await expect(fallback.getByText('− const source = "csv";')).toBeVisible();
  await expect(fallback.getByText('+ const source = "noaa";')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("run-diff-fallback-desktop.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
