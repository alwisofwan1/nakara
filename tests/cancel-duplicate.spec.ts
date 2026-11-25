import { expect, test } from "@playwright/test";

test("Cancel asks for confirmation and Duplicate creates a prefilled new item", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Projects share servers, so each cancels and duplicates its own item.
  const title = `Cancel and duplicate (${testInfo.project.name})`;
  const request = "Copy **this** request.\n\nAcceptance: it is copied.";
  await page.goto("./activity");
  const created = await page.request.post("./api/f/default/items", {
    data: {
      title,
      request,
      repo: "acme/gadgets",
      automation: "issue-labeled",
      budgetUsd: 5,
      requester: "alwi",
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: number };
  await page.goto(`./items/${id}`);
  let loads = 0;
  page.on("load", () => loads++);

  // Dismissing the confirmation keeps the item going.
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await cancel.click();
  const dialog = page.getByRole("dialog", { name: `Cancel #${id}?` });
  await expect(dialog).toContainText("Cancelling is final");
  await expect(dialog).toContainText(
    "Kept: the branch and any draft PR stay on GitHub.",
  );
  await expect(dialog).toContainText("Removed: the item's local worktree.");
  await page.screenshot({ path: testInfo.outputPath("cancel-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("cancel-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await dialog.getByRole("button", { name: "Keep working" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Message the factory")).toBeVisible();

  await cancel.click();
  await dialog.getByRole("button", { name: "Cancel work item" }).click();
  await expect(dialog).toBeHidden();
  const card = page.getByRole("region", { name: "Action" });
  await expect(card).toContainText("Cancelled");
  await expect(cancel).toHaveCount(0);

  await card.getByRole("button", { name: "Duplicate as new work" }).click();
  const modal = page.getByRole("dialog", { name: "New work" });
  await expect(modal.getByLabel("Title")).toHaveValue(title);
  await expect(modal.getByLabel(/Markdown/)).toHaveValue(request);
  await expect(modal.getByLabel("Repository")).toHaveValue("acme/gadgets");
  await expect(modal.getByLabel("Automation")).toHaveValue("issue-labeled");
  await page.screenshot({ path: testInfo.outputPath("duplicate-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(modal).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("duplicate-mobile.png") });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });

  const duplicated = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/f/default/items") &&
      r.request().method() === "POST",
  );
  await modal.getByRole("button", { name: "Create work item" }).click();
  const response = await duplicated;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({
    title,
    request,
    issueUrl: "",
    repo: "acme/gadgets",
    automation: "issue-labeled",
    budgetUsd: 15,
    requester: "operator",
  });
  const { id: copy } = (await response.json()) as { id: number };
  expect(copy).not.toBe(id);
  await page.waitForURL(new RegExp(`/items/${copy}$`));
  await expect(modal).toBeHidden();
  await expect(
    page.getByRole("heading", { level: 1, name: `#${copy} ${title}` }),
  ).toBeVisible();
  const properties = page.getByRole("complementary", { name: "Properties" });
  await expect(properties).toContainText("acme/gadgets");
  await expect(properties).toContainText("issue-labeled");
  await expect(page.getByLabel("Message the factory")).toBeVisible();
  expect(loads).toBe(0);
  expect(errors).toEqual([]);
});
