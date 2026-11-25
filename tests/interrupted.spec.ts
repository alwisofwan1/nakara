import { expect, test } from "@playwright/test";

// See tests/server.ts: a run a restart interrupted, and the queued run that
// resumes it in its session. Read-only, so every project shares the fixture.
const TITLE = "Interrupted by a restart";

test("an interrupted run shows on the Runs list, its run page and its work item", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("./runs");
  await page
    .getByRole("navigation", { name: "Filter by status" })
    .getByRole("link", { name: "Interrupted", exact: true })
    .click();
  await expect(page).toHaveURL(/status=interrupted/);
  const rows = page.locator("main li");
  const row = rows.filter({ hasText: TITLE });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(/implement run #\d+/);
  await expect(row.getByText("Interrupted", { exact: true })).toBeVisible();
  // Only interrupted runs match: the queued resume is not listed.
  await expect(rows.filter({ hasText: "Smoke test work item" })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("runs-interrupted-desktop.png"),
    fullPage: true,
  });

  await row.getByRole("link", { name: /implement run #/ }).click();
  await expect(
    page.getByRole("heading", { name: "implement · claude:opus" }),
  ).toBeVisible();
  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasNotText: "Lighthouse" }),
  ).toHaveText(
    /^Nakara restarted while this run was in progress\. Run #\d+ continues it in the same session\.$/,
  );
  await page.screenshot({
    path: testInfo.outputPath("run-interrupted-desktop.png"),
    fullPage: true,
  });

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: new RegExp(TITLE) })
    .click();
  await expect(page).toHaveURL(/\/items\/\d+$/);
  await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
  const card = page
    .locator("article")
    .filter({ hasText: /continues it in the same session/ });
  await expect(card.getByText("Interrupted", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("item-interrupted-desktop.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
