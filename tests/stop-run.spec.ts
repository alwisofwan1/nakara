import { expect, test } from "@playwright/test";

test("Stop run cancels a running run after confirmation and refuses it again", async ({
  page,
}, testInfo) => {
  // See tests/server.ts: root and dev share a server, so each stops its own run.
  const runId = testInfo.project.name === "dev" ? 12 : 11;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let loads = 0;
  page.on("load", () => {
    loads++;
  });
  await page.goto(`./runs/${runId}`);
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByRole("log", { name: "Run log" })).toContainText(
    "Dispatching implement.",
  );
  const stop = page.getByRole("button", { name: "Stop run" });
  await expect(stop).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("stop-run-desktop.png"),
    fullPage: true,
  });

  await stop.click();
  const dialog = page.getByRole("dialog", { name: `Stop run #${runId}?` });
  await expect(dialog).toContainText("The work item is not cancelled");
  await page.screenshot({
    path: testInfo.outputPath("stop-run-dialog-desktop.png"),
  });
  await dialog.getByRole("button", { name: "Keep running" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();

  await stop.click();
  await dialog.getByRole("button", { name: "Stop run" }).click();
  await expect(dialog).toBeHidden();
  // The cancelled status arrives through /api/events; nothing reloads.
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasNotText: "Lighthouse" }),
  ).toHaveText("Stopped by the operator.");
  await expect(stop).toBeDisabled();
  await expect(page.getByText(/^Run ended/)).toBeVisible();
  expect(loads).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("stop-run-cancelled-desktop.png"),
    fullPage: true,
  });

  const again = await page.request.post(`./api/runs/${runId}/stop`);
  expect(again.status()).toBe(409);
  expect(await again.json()).toEqual({
    error: {
      code: "policy",
      message: "Only a running run can be stopped. This run is cancelled.",
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(stop).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("stop-run-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
