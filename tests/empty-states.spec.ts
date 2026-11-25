import { expect, type Page, test } from "@playwright/test";

// The shared fixture has repositories, items and agents, so each page sees
// an empty API response instead.
const noItems = (page: Page) =>
  page.route("**/api/f/default/items", (route) =>
    route.fulfill({
      json: {
        items: [],
        summary: { open: 0, needsYou: 0, costUsd: 0 },
        outcomes: {
          prs: 0,
          merged: 0,
          closedUnmerged: 0,
          revisionsPerItem: null,
          costPerMergedPrUsd: null,
          medianCycleHours: null,
        },
        lessons: [],
        uncheckedCorrections: 0,
      },
    }),
  );
// A fixed copy: proxying live refetches races the navigations below.
const noRepositories = async (page: Page) => {
  const status = await (await page.request.get("./api/status")).json();
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        ...status,
        factories: status.factories.map((f: { slug: string }, index: number) =>
          index === 0 ? { ...f, repositories: 0 } : f,
        ),
      },
    }),
  );
};

async function screenshots(page: Page, name: string, outputPath: string) {
  await page.screenshot({
    path: `${outputPath}/${name}-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${outputPath}/${name}-390.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("Activity with no items offers New work", async ({ page }, testInfo) => {
  await noItems(page);
  await page.goto("./activity");
  const empty = page.getByRole("region", { name: "No work yet" });
  await expect(empty).toContainText(
    "Create work, label an issue factory:Nakara, or message the Telegram bot.",
  );
  await expect(
    page.getByRole("region", { name: "Add a repository to start" }),
  ).toHaveCount(0);
  await screenshots(page, "activity-no-items", testInfo.outputPath());
  await empty.getByRole("link", { name: "New work" }).click();
  await expect(page).toHaveURL(/[?&]new=1/);
  await expect(page.getByRole("dialog", { name: "New work" })).toBeVisible();
});

test("Activity with no repositories links to the definition", async ({
  page,
}, testInfo) => {
  await noItems(page);
  await noRepositories(page);
  await page.goto("./activity");
  const empty = page.getByRole("region", { name: "Add a repository to start" });
  await expect(empty).toContainText(
    "Nakara needs at least one repository in factory.yaml before agents can work.",
  );
  // Adding a repository is the only next step until one exists.
  await expect(page.getByRole("region", { name: "No work yet" })).toHaveCount(
    0,
  );
  await screenshots(page, "activity-no-repositories", testInfo.outputPath());
  await empty.getByRole("link", { name: "Add repository" }).click();
  await expect(page).toHaveURL(/\/definition$/);
  await expect(
    page.getByRole("heading", { name: "Factory definition", exact: true }),
  ).toBeVisible();
});

test("Activity keeps listing items when the repositories are gone", async ({
  page,
}) => {
  await noRepositories(page);
  await page.goto("./activity");
  await expect(
    page.getByRole("region", { name: "Add a repository to start" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Building" })).toBeVisible();
});

test("Agents with no agents links to New agent", async ({ page }, testInfo) => {
  await page.route("**/api/f/default/agents", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.goto("./agents");
  const empty = page.getByRole("region", { name: "No agents" });
  await expect(empty).toContainText(
    "A factory needs a foreman. Start from the example tree or create one.",
  );
  await screenshots(page, "agents-none", testInfo.outputPath());
  await empty.getByRole("link", { name: "New agent" }).click();
  await expect(page).toHaveURL(/\/agents\/new$/);
  await expect(
    page.getByRole("heading", { name: "New agent", exact: true }),
  ).toBeVisible();
});
