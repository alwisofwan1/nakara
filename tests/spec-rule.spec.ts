import { expect, type Page, test } from "@playwright/test";

// See tests/server.ts: Harbor is a second factory with its own definition.

const openNewWork = async (page: Page) => {
  await page.getByRole("button", { name: "New work", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New work" });
  await expect(dialog.getByLabel("Requester")).toBeVisible();
  return dialog;
};

test("Spec before code: the Settings choice decides the New work switch", async ({
  page,
}, testInfo) => {
  // The dev project shares the root project's server: only one changes Harbor.
  test.skip(testInfo.project.name === "dev");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./f/harbor/settings");
  const rule = page
    .getByRole("region", { name: "Limits" })
    .getByRole("group", { name: "Spec before code" });
  const option = (name: string) => rule.getByRole("button", { name });
  await expect(option("When triage asks")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("region", { name: "Limits" })).toContainText(
    "A Spec is written into the Pull Request, and you approve it before implement starts.",
  );
  const spec = (dialog: ReturnType<Page["getByRole"]>) =>
    dialog.getByRole("switch", { name: /Write a Spec first/ });

  // When triage asks: off by default, and the requester may turn it on.
  let dialog = await openNewWork(page);
  await expect(spec(dialog)).not.toBeChecked();
  await expect(spec(dialog)).toBeEnabled();
  await spec(dialog).check();
  await expect(spec(dialog)).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("spec-when-asked.png") });
  await page.keyboard.press("Escape");

  // Always: shown on and locked.
  await option("Always").click();
  await expect(
    page.locator(".toast").getByText("Spec rule saved", { exact: true }),
  ).toBeVisible();
  await expect(option("Always")).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: testInfo.outputPath("settings-spec-always.png"),
    fullPage: true,
  });
  dialog = await openNewWork(page);
  await expect(spec(dialog)).toBeChecked();
  await expect(spec(dialog)).toBeDisabled();
  await expect(dialog).toContainText("#harbor always asks for one.");
  await page.screenshot({ path: testInfo.outputPath("spec-always.png") });
  await page.keyboard.press("Escape");

  // Never: no switch.
  await option("Never").click();
  await expect(option("Never")).toHaveAttribute("aria-pressed", "true");
  dialog = await openNewWork(page);
  await expect(spec(dialog)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("spec-never.png") });
  await page.keyboard.press("Escape");

  // The choice survives a reload; put Harbor back as it was.
  await page.reload();
  await expect(option("Never")).toHaveAttribute("aria-pressed", "true");
  await option("When triage asks").click();
  await expect(option("When triage asks")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The row fits a phone.
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("settings-spec-360.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
