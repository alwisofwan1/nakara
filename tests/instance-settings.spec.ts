import { expect, test } from "@playwright/test";

// Projects share servers and the shell tests read "Slots · 1/2 busy", so this
// test only saves the default's own value (2) and clears it again: the
// effective concurrency never changes. src/web/api.test.ts and
// src/orchestrator/registry.test.ts cover other values.
test("instance settings: concurrency from the sidebar, saved and cleared with a toast, at 390px", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./inbox");
  await page
    .locator(".desktop-sidebar")
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  const runs = page.getByRole("region", { name: "Runs" });
  const field = runs.getByRole("spinbutton", { name: /Concurrent agent runs/ });
  await expect(field).toHaveValue("");
  await expect(field).toHaveAttribute("placeholder", "Default: 2");
  await expect(runs).toContainText("In use now1 of 2 slots");
  await expect(runs).toContainText("Default2 (in use)");

  // Out of range: the browser refuses it, nothing is sent.
  await field.fill("11");
  await field.press("Enter");
  await expect(runs.getByRole("alert")).toBeVisible();

  const toast = page.locator(".toast");
  await field.fill("2");
  await field.press("Enter");
  await expect(
    toast.filter({ hasText: "Concurrent agent runs: 2." }),
  ).toBeVisible();
  await expect(runs).not.toContainText("(in use)");
  await page.screenshot({
    path: testInfo.outputPath("instance-settings-desktop.png"),
    fullPage: true,
  });

  // Empty and blur: back to the default.
  await field.fill("");
  await field.blur();
  await expect(
    toast.filter({ hasText: "Concurrent agent runs: default (2)." }),
  ).toBeVisible();
  await expect(runs).toContainText("Default2 (in use)");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(field).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("instance-settings-390.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
