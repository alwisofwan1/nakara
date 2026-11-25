import { expect, test } from "@playwright/test";

// A fixed blueprint: the shared fixture records few stage moves.
const STAGES = [
  "intake",
  "triage",
  "planning",
  "building",
  "reviewing",
  "handoff",
  "complete",
  "cancelled",
];
const blueprint = {
  stages: STAGES.map((stage) => ({
    stage,
    runs: stage === "building" ? 5 : stage === "reviewing" ? 3 : 0,
    open: stage === "building" ? 2 : 0,
    entered: stage === "cancelled" ? 1 : 4,
  })),
  transitions: [
    { from: "intake", to: "triage", designed: true, count: 4 },
    { from: "triage", to: "building", designed: true, count: 3 },
    { from: "triage", to: "planning", designed: true, count: 0 },
    { from: "building", to: "reviewing", designed: true, count: 3 },
    { from: "reviewing", to: "building", designed: true, count: 2 },
    { from: "reviewing", to: "handoff", designed: true, count: 2 },
    { from: "handoff", to: "complete", designed: true, count: 1 },
    { from: "building", to: "cancelled", designed: false, count: 1 },
  ],
};

test("the blueprint draws the stages and filters moves by the chosen one", async ({
  page,
}, testInfo) => {
  await page.route("**/api/f/default/blueprint", (route) =>
    route.fulfill({ json: blueprint }),
  );
  await page.goto("./f/default/blueprint");
  await expect(page.getByRole("heading", { name: "Blueprint" })).toBeVisible();
  const building = page.getByRole("button", { name: /^Building/ });
  await expect(building).toContainText("5 runs");
  await expect(building).toContainText("2 open");
  const transitions = page.getByRole("complementary").getByRole("listitem");
  await expect(transitions).toHaveCount(8);
  await page.screenshot({
    path: testInfo.outputPath("blueprint-desktop.png"),
    fullPage: true,
  });

  await building.click();
  await expect(building).toHaveAttribute("aria-pressed", "true");
  await expect(transitions).toHaveCount(4);
  await expect(page.getByText("Building → Cancelled")).toBeVisible();
  await expect(page.getByText("off path")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("blueprint-390.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
