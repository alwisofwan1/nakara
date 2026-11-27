import { expect, test } from "@playwright/test";

// See tests/server.ts: Harbor is a second factory; the smoke server runs no Slack bridge.

test("Notifications: a Slack channel and three switches, saved per factory", async ({
  page,
}, testInfo) => {
  // The dev project shares the root project's server: only one changes Harbor.
  test.skip(testInfo.project.name === "dev");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./f/harbor/settings");
  const section = page.getByRole("region", {
    name: "Notifications",
    exact: true,
  });
  const channel = section.getByLabel("Slack channel");
  const when = section.getByRole("group", { name: "Notify me when" });
  const switches = [
    "A Spec or Question waits",
    "A Pull Request is ready to merge",
    "A Work Item pauses at its Budget",
  ].map((name) => when.getByRole("switch", { name }));
  await expect(channel).toHaveAttribute("placeholder", "#channel");
  await expect(channel).toHaveValue("");
  // Unsaved switches are on.
  for (const s of switches) await expect(s).toBeChecked();
  await expect(section).toContainText("Slack is not connected yet. See Setup.");
  await expect(section.getByRole("link", { name: "Setup" })).toBeVisible();

  // Without the bridge, the channel is saved as given.
  await channel.fill("#releases");
  await channel.press("Enter");
  await expect(
    page.locator(".toast").getByText("Notifications saved", { exact: true }),
  ).toBeVisible();
  // biome-ignore lint/style/noNonNullAssertion: Three switches above.
  const handoff = switches[1]!;
  await handoff.click();
  await expect(handoff).not.toBeChecked();
  await page.reload();
  await expect(channel).toHaveValue("#releases");
  await expect(handoff).not.toBeChecked();
  await expect(switches[0] ?? handoff).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("settings-notifications.png"),
    fullPage: true,
  });

  // Put Harbor back as it was.
  await handoff.click();
  await expect(handoff).toBeChecked();
  await channel.fill("");
  await channel.press("Enter");
  await page.reload();
  await expect(channel).toHaveValue("");
  await expect(handoff).toBeChecked();
  expect(errors).toEqual([]);
});
