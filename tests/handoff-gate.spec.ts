import { expect, test } from "@playwright/test";

// See tests/server.ts: Harbor is a second factory with its own definition.

test("Handoff Gate: CI is on and locked, Review and Verification switch on and off", async ({
  page,
}, testInfo) => {
  // The dev project shares the root project's server: only one changes Harbor.
  test.skip(testInfo.project.name === "dev");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./f/harbor/settings");
  const gate = page
    .getByRole("region", { name: "Limits" })
    .getByRole("group", { name: "Handoff Gate" });
  const ci = gate.getByRole("switch", { name: /CI passes/ });
  const review = gate.getByRole("switch", { name: "Review accepted" });
  const verification = gate.getByRole("switch", {
    name: "Verification passed",
  });
  // Harbor's definition has no verify agent, and its review limit is 1.
  const oneReview = gate.getByRole("note").filter({
    hasText:
      "a review that asks for changes leaves the Work Item waiting for you",
  });
  const noVerifyAgent = gate.getByRole("note").filter({
    hasText: "has no verify agent, so no Verification can pass",
  });
  await expect(ci).toBeChecked();
  await expect(ci).toBeDisabled();
  await expect(oneReview).toBeHidden();
  await expect(noVerifyAgent).toBeHidden();
  await expect(review).not.toBeChecked();
  await expect(verification).not.toBeChecked();
  await expect(page.getByRole("region", { name: "Limits" })).toContainText(
    "The work is always pushed and CI always passes. A factory can add checks; it cannot remove those.",
  );

  await review.click();
  await expect(review).toBeChecked();
  await expect(
    page.locator(".toast").getByText("Handoff Gate saved", { exact: true }),
  ).toBeVisible();
  await expect(oneReview).toBeVisible();
  await expect(noVerifyAgent).toBeHidden();
  await verification.click();
  await expect(verification).toBeChecked();
  // Saved with the warning: the definition can change after the save.
  await expect(noVerifyAgent).toBeVisible();
  // Saved: both survive a reload, and CI is still locked on.
  await page.reload();
  await expect(review).toBeChecked();
  await expect(verification).toBeChecked();
  await expect(ci).toBeChecked();
  await expect(ci).toBeDisabled();
  await expect(oneReview).toBeVisible();
  await expect(noVerifyAgent).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("settings-handoff-gate.png"),
    fullPage: true,
  });

  // Put Harbor back as it was.
  await review.click();
  await expect(review).not.toBeChecked();
  await verification.click();
  await expect(verification).not.toBeChecked();
  await page.reload();
  await expect(review).not.toBeChecked();
  await expect(verification).not.toBeChecked();
  await expect(oneReview).toBeHidden();
  await expect(noVerifyAgent).toBeHidden();
  expect(errors).toEqual([]);
});
