import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { smokeHarborDir } from "./smoke.ts";

// See tests/server.ts: the fixture registers two factories, Default and Harbor.

test("the sidebar lists every factory, and Inbox and Runs filter by factory", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Not getByLabel: the sidebar's "New factory" link would match too.
  const factoryFilter = page.getByRole("combobox", {
    name: "Factory",
    exact: true,
  });
  await page.goto("./inbox");
  const sidebar = page.locator(".desktop-sidebar");
  const factories = sidebar.getByRole("navigation", { name: "Factories" });
  await expect(factories).toContainText("Factories");
  await expect(
    factories.getByRole("link", { name: "New factory" }),
  ).toBeVisible();
  for (const [name, slug] of [
    ["Default", "default"],
    ["Harbor", "harbor"],
  ]) {
    const group = factories.getByRole("group", { name });
    await expect(group.locator(".factory-avatar")).toHaveText(
      name?.charAt(0) ?? "",
    );
    await expect(
      group.getByRole("link", { name: "Activity", exact: true }),
    ).toHaveAttribute("href", new RegExp(`/f/${slug}/activity$`));
  }

  // The Inbox spans factories; the filter keeps one factory's items.
  const rows = page.getByRole("list", { name: "Needs you" });
  const harbor = rows.getByRole("button", { name: /Harbor berth schedule/ });
  const smoke = rows.getByRole("button", { name: /Smoke test work item/ });
  await expect(harbor).toContainText("Harbor");
  await expect(smoke).toContainText("Default");
  await page.screenshot({
    path: testInfo.outputPath("inbox-all-factories.png"),
    fullPage: true,
  });
  await factoryFilter.selectOption("harbor");
  await expect(page).toHaveURL(/factory=harbor/);
  await expect(harbor).toBeVisible();
  await expect(smoke).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "Filter by kind" })
      .getByRole("button", { name: /^All \d+$/ }),
  ).toHaveText("All 1");
  await page.screenshot({
    path: testInfo.outputPath("inbox-harbor.png"),
    fullPage: true,
  });
  await factoryFilter.selectOption("default");
  await expect(smoke).toBeVisible();
  await expect(harbor).toHaveCount(0);

  // Runs span factories too.
  await page.goto("./runs");
  const runs = page.locator("main li");
  const tideRun = runs.filter({ hasText: "Harbor tide table import" });
  const smokeRun = runs.filter({ hasText: "Smoke test work item" });
  await expect(tideRun).toHaveCount(1);
  await expect(tideRun).toContainText("Harbor");
  await expect(smokeRun.first()).toBeVisible();
  await factoryFilter.selectOption("harbor");
  await expect(page).toHaveURL(/factory=harbor/);
  await expect(tideRun).toHaveCount(1);
  await expect(smokeRun).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("runs-harbor.png"),
    fullPage: true,
  });
  await factoryFilter.selectOption("");
  await expect(smokeRun.first()).toBeVisible();

  // Each factory's Activity shows only its own items.
  await factories
    .getByRole("group", { name: "Harbor" })
    .getByRole("link", { name: "Activity", exact: true })
    .click();
  await expect(page).toHaveURL(/\/f\/harbor\/activity$/);
  await expect(page.getByText("Harbor tide table import")).toBeVisible();
  await expect(page.getByText("Smoke test work item")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
      name: "Harbor",
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("activity-harbor.png"),
    fullPage: true,
  });
  // An item page names its own factory.
  await page.getByText("Harbor tide table import").click();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
      name: "Harbor",
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("a factory without a valid definition is flagged while the others keep running", async ({
  page,
}, testInfo) => {
  // Lighthouse's definition is broken from the start (see tests/server.ts).
  await page.goto("./f/default/activity");
  const banner = page.getByRole("alert").filter({ hasText: "Lighthouse" });
  await expect(banner).toHaveText(
    /^Lighthouse has no valid definition loaded \(\d+ errors?\); the other factories keep running\. See Definition\.$/,
  );
  await expect(
    banner.getByRole("link", { name: "Definition" }),
  ).toHaveAttribute("href", /\/f\/lighthouse\/definition$/);
  const sidebar = page.locator(".desktop-sidebar");
  await expect(
    sidebar
      .getByRole("group", { name: "Lighthouse" })
      .getByText("No valid definition is loaded"),
  ).toBeAttached();
  for (const name of ["Default", "Harbor"])
    await expect(
      sidebar
        .getByRole("group", { name })
        .getByText("No valid definition is loaded"),
    ).toHaveCount(0);
  // The default factory keeps running and listing its work.
  await expect(
    page.getByRole("heading", { name: "Activity", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Smoke test work item")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("broken-factory-flagged.png"),
    fullPage: true,
  });
  // Its own Definition page shows the errors.
  await banner.getByRole("link", { name: "Definition" }).click();
  await expect(page).toHaveURL(/\/f\/lighthouse\/definition$/);
  await expect(page.getByRole("main")).toContainText("factory.yaml");
  await page.screenshot({
    path: testInfo.outputPath("lighthouse-definition.png"),
    fullPage: true,
  });
});

test("a broken definition shows its errors on its own factory only", async ({
  page,
}, testInfo) => {
  // The dev project shares the root project's server; only one may edit its files.
  test.skip(testInfo.project.name === "dev", "Shares the root server");
  const baseURL = testInfo.project.use.baseURL ?? "";
  const yaml = join(
    smokeHarborDir(Number(new URL(baseURL).port)),
    "factory.yaml",
  );
  const original = await readFile(yaml, "utf8");
  await writeFile(yaml, "kind: [unclosed\n");
  try {
    await page.goto("./f/harbor/definition");
    await page.getByRole("button", { name: "Reload definition" }).click();
    const banner = page
      .getByRole("alert")
      .filter({ hasText: /is still running/ });
    await expect(banner).toContainText("Reload failed");
    await expect(banner).toContainText("factory.yaml");
    await page.screenshot({
      path: testInfo.outputPath("harbor-definition-errors.png"),
      fullPage: true,
    });
    // The default factory's definition is untouched and runs on.
    await page.goto("./f/default/definition");
    await expect(
      page.getByRole("heading", { name: "Factory definition", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: /Reload failed/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: "Definition files" }),
    ).toContainText("factory.yaml");
  } finally {
    await writeFile(yaml, original);
  }
  await page.goto("./f/harbor/definition");
  await page.getByRole("button", { name: "Reload definition" }).click();
  await expect(
    page.locator(".toast").getByText("Definition reloaded", { exact: true }),
  ).toBeVisible();
});
