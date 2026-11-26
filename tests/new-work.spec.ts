import { expect, test } from "@playwright/test";

test("New work modal creates an item, imports issues and closes on Esc", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await page.getByRole("button", { name: "New work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New work" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/[?&]new=1/);
  await expect(dialog.getByLabel("Budget")).toHaveValue("15.00");
  await expect(dialog.getByLabel("Automation")).toHaveValue("nakara-manual");
  await expect(dialog.getByLabel("Requester")).toHaveValue("operator");

  // Pasting an issue URL replaces the title and request; refusals are shown in the modal.
  const issueUrl = dialog.getByLabel(/Or paste a GitHub issue URL/);
  await issueUrl.fill("https://github.com/someone/else/issues/1");
  await expect(dialog.getByLabel("Title")).toBeDisabled();
  await expect(dialog.getByLabel(/Markdown/)).toBeDisabled();
  await dialog.getByRole("button", { name: "Create work item" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "someone/else is not a repository of this factory.",
  );
  await page.screenshot({ path: testInfo.outputPath("desktop-import.png") });
  await issueUrl.fill("");
  await expect(dialog.getByRole("alert")).toBeHidden();

  await dialog.getByLabel("Title").fill("Add retry button to failed items");
  await dialog
    .getByLabel(/Markdown/)
    .fill("When a run fails, offer **Retry** next to Cancel.");
  await dialog.getByLabel("Repository").selectOption("acme/gadgets");
  await dialog.getByLabel("Budget").fill("7.50");
  await dialog.getByLabel("Requester").fill("alwi");
  await page.screenshot({ path: testInfo.outputPath("desktop.png") });

  const created = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/f/default/items") &&
      r.request().method() === "POST",
  );
  await dialog.getByLabel(/Markdown/).press("Control+Enter");
  const response = await created;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({
    title: "Add retry button to failed items",
    request: "When a run fails, offer **Retry** next to Cancel.",
    issueUrl: "",
    repo: "acme/gadgets",
    automation: "nakara-manual",
    budgetUsd: 7.5,
    requester: "alwi",
    spec: false,
  });
  await page.waitForURL(/\/items\/\d+$/);
  const id = page.url().split("/").pop();
  await expect(
    page.getByRole("heading", {
      name: `#${id} Add retry button to failed items`,
    }),
  ).toBeVisible();
  const properties = page.getByRole("complementary", { name: "Properties" });
  await expect(properties).toContainText("$0.00 of $7.50");
  await expect(properties).toContainText("Manual");
  await expect(properties).toContainText("acme/gadgets");
  await expect(properties).toContainText("alwi");
  await page.screenshot({ path: testInfo.outputPath("desktop-created.png") });

  // The header button opens the same modal on any page; Esc closes it.
  await page.getByRole("button", { name: "New work", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/new=1/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "New work", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile.png") });
  await dialog
    .getByRole("button", { name: "Create work item" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("mobile-footer.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});
