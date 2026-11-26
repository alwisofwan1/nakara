import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { smokeDefinitionDir } from "./smoke.ts";

// See tests/server.ts: Quarry is a Nakara-managed factory with one active item.

test("factory settings: rename, managed history, delete refused, move and delete", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sidebar = page
    .locator(".desktop-sidebar")
    .getByRole("navigation", { name: "Factories" });
  // The dev project shares the root project's server, which changes Quarry:
  // it only opens Harbor's settings.
  if (testInfo.project.name === "dev") {
    await page.goto("./f/harbor/settings");
    await expect(
      page.getByRole("textbox", { name: "Display name" }),
    ).toHaveValue("Harbor");
    expect(errors).toEqual([]);
    return;
  }
  await page.goto("./f/quarry/settings");
  await expect(
    page.getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar
      .getByRole("group", { name: "Quarry" })
      .getByRole("link", { name: "Settings" }),
  ).toHaveAttribute("aria-current", "page");
  const definition = page.getByRole("region", { name: "Definition" });
  await expect(definition).toContainText("Nakara-managed");
  await page.screenshot({
    path: testInfo.outputPath("settings-desktop.png"),
    fullPage: true,
  });
  await expectLimitsBesideLabels(page);

  // Rename: the sidebar follows, the URL stays.
  const name = page.getByRole("textbox", { name: "Display name" });
  await expect(name).toHaveValue("Quarry");
  await name.fill("Quarry Works");
  await page.getByRole("radio", { name: "#b45309" }).check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(
    page.locator(".toast").getByText("Settings saved", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/f\/quarry\/settings$/);
  const group = sidebar.getByRole("group", { name: "Quarry Works" });
  await expect(group.locator(".factory-avatar")).toHaveCSS(
    "background-color",
    "rgb(180, 83, 9)",
  );
  await expect(
    group.getByRole("link", { name: "Activity", exact: true }),
  ).toHaveAttribute("href", /\/f\/quarry\/activity$/);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
      name: "Quarry Works",
    }),
  ).toBeVisible();

  // A web edit of the managed definition is a commit.
  await expect(definition).toContainText("No commits yet");
  await page.goto("./f/quarry/agents/new");
  await page.getByRole("textbox", { name: "Name" }).fill("surveyor");
  await page
    .getByRole("textbox", { name: "Prompt" })
    .fill("# Surveyor\n\nMap the site.");
  await page.getByRole("button", { name: "Create agent" }).click();
  await expect(
    page.locator(".toast").getByText("Agent created", { exact: true }),
  ).toBeVisible();
  await group.getByRole("link", { name: "Settings" }).click();
  const history = page.getByRole("list", { name: "Definition history" });
  await expect(history.getByRole("listitem")).toHaveText([
    /Create agent surveyor/,
    /Initial definition/,
  ]);

  // Two description saves in a row: the second one uses the revision the
  // first wrote, even while the settings are still refetching.
  await page.route("**/api/f/quarry/settings", async (route) => {
    if (route.request().method() === "GET")
      await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fallback();
  });
  const description = page.getByRole("textbox", { name: "Description" });
  const saveDescription = async (text: string) => {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" &&
        r.url().endsWith("/api/f/quarry/settings/definition"),
    );
    await description.fill(text);
    await description.press("Enter");
    return (await response).status();
  };
  expect(await saveDescription("Quarry digs gravel.")).toBe(200);
  expect(await saveDescription("Quarry digs gravel and sand.")).toBe(200);
  await expect(
    page.getByRole("form", { name: "General" }).getByRole("alert"),
  ).toHaveCount(0);
  await page.unroute("**/api/f/quarry/settings");
  await expect(page.locator(".header-description")).toHaveText(
    "Quarry digs gravel and sand.",
  );
  const stored = await (await request.get("./api/f/quarry/settings")).json();
  expect(stored.factoryFile.description).toBe("Quarry digs gravel and sand.");
  await expect(history.getByRole("listitem")).toHaveText([
    /Edit factory settings/,
    /Edit factory settings/,
    /Create agent surveyor/,
    /Initial definition/,
  ]);
  await page.screenshot({
    path: testInfo.outputPath("settings-history-desktop.png"),
    fullPage: true,
  });

  // Delete is refused while the factory has an active item.
  const remove = page.getByRole("dialog", { name: "Delete Quarry Works?" });
  await page.getByRole("button", { name: "Delete factory" }).click();
  await remove.getByRole("button", { name: "Delete factory" }).click();
  await expect(remove.getByRole("alert")).toHaveText(
    "Quarry Works has 1 active work item. Complete or cancel it first.",
  );
  const baseURL = testInfo.project.use.baseURL ?? "";
  const data = join(
    smokeDefinitionDir(Number(new URL(baseURL).port)),
    "..",
    "data",
  );
  // The dialog names the snapshot taken before a delete.
  await expect(remove).toContainText(
    `First, a snapshot of the database (reason pre-delete-quarry) is saved in ${join(data, "backups")}.`,
  );
  await page.screenshot({
    path: testInfo.outputPath("settings-delete-refused-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("settings-delete-refused-390.png"),
    fullPage: true,
  });
  await remove.getByRole("button", { name: "Keep factory" }).click();
  await page.screenshot({
    path: testInfo.outputPath("settings-390.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expectLimitsBesideLabels(page);
  // A phone's wider fonts wrap labels at 390px that headless Chromium's fit;
  // 360px makes the same squeeze here.
  await page.setViewportSize({ width: 360, height: 800 });
  await expectLimitsBesideLabels(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Move writes the tree into the repository folder and switches the mode.
  await page
    .getByRole("combobox", { name: "Repository" })
    .selectOption("acme/widgets");
  await page.getByRole("textbox", { name: "Folder" }).fill("ops/quarry");
  // The section and the confirmation name the archive the same way.
  const archive = join(data, "archive", "factories", "quarry");
  const archived = `The Nakara-managed folder, with its git history, is kept as an archive in ${archive}.`;
  await expect(definition).toContainText(archived);
  await page.getByRole("button", { name: "Move definition" }).click();
  const confirm = page.getByRole("dialog", {
    name: "Move the definition to acme/widgets?",
  });
  await expect(confirm).toContainText(archived);
  await page.screenshot({
    path: testInfo.outputPath("settings-move-dialog-desktop.png"),
    fullPage: true,
  });
  await confirm.getByRole("button", { name: "Move definition" }).click();
  await expect(
    page.locator(".toast").getByText("Definition moved", { exact: true }),
  ).toBeVisible();
  const moved = join(data, "checkouts", "acme", "widgets", "ops", "quarry");
  await expect(definition).toContainText("A repository folder");
  await expect(definition).toContainText(moved);
  await expect(history).toHaveCount(0);
  expect((await stat(join(moved, "agents/surveyor/agent.md"))).isFile()).toBe(
    true,
  );
  // The managed folder is archived with its git history.
  expect((await stat(join(archive, ".git"))).isDirectory()).toBe(true);
  expect((await stat(join(archive, "agents/surveyor/agent.md"))).isFile()).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("settings-moved-desktop.png"),
    fullPage: true,
  });

  // Once its item is cancelled, the factory is deleted.
  const item = findItem(
    await (await request.get("./api/f/quarry/items")).json(),
    "Quarry gravel survey",
  );
  expect(item).toBeDefined();
  expect((await request.post(`./api/items/${item}/cancel`)).status()).toBe(200);
  await page.getByRole("button", { name: "Delete factory" }).click();
  await remove.getByRole("button", { name: "Delete factory" }).click();
  await expect(
    page.locator(".toast").getByText("Factory deleted", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/f\/default\/activity$/);
  await expect(
    sidebar.getByRole("group", { name: "Quarry Works" }),
  ).toHaveCount(0);
  expect((await request.get("./api/f/quarry/settings")).status()).toBe(404);
  expect(errors).toEqual([]);
});

/**
 * Every Limits input sits beside its label, right-aligned in one column,
 * whatever the label's length; the `$` sits just left of the budget input.
 */
async function expectLimitsBesideLabels(page: Page) {
  type Box = Record<"top" | "bottom" | "left" | "right", number>;
  const rows = await page
    .getByRole("region", { name: "Limits" })
    .locator(".limit-input")
    .evaluateAll((spans) =>
      spans.map((span) => {
        const box = (element: Element | null | undefined) =>
          element?.getBoundingClientRect().toJSON() as Box | undefined;
        return {
          label: box(span.parentElement?.querySelector("label")),
          input: box(span.querySelector("input")),
          dollar: box(span.querySelector("span")),
        };
      }),
    );
  expect(rows).toHaveLength(4);
  const right = rows[0]?.input?.right;
  for (const { label, input } of rows) {
    if (!label || !input)
      throw new Error("A Limits row lacks its label or input");
    expect(input.left).toBeGreaterThanOrEqual(label.right);
    expect(input.top).toBeLessThan(label.bottom);
    expect(input.bottom).toBeGreaterThan(label.top);
    expect(input.right).toBe(right);
  }
  const { input, dollar } = rows[0] ?? {};
  if (!input || !dollar) throw new Error("The budget row lacks its `$`");
  expect(dollar.right).toBeLessThanOrEqual(input.left);
  expect(input.left - dollar.right).toBeLessThan(8);
  expect(dollar.top).toBeLessThan(input.bottom);
  expect(dollar.bottom).toBeGreaterThan(input.top);
}

/** The id of the item titled `title` anywhere in an API response. */
function findItem(value: unknown, title: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { id?: unknown; title?: unknown };
  if (record.title === title && typeof record.id === "number") return record.id;
  for (const child of Object.values(value)) {
    const id = findItem(child, title);
    if (id !== undefined) return id;
  }
  return undefined;
}
