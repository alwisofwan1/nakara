import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { hasGithubIntake, type Intake, WhereWorkComesFrom } from "./intake-row";

// The API module reads the page's runtime config; rendering never saves.
vi.mock("../../lib/api", () => ({
  ApiError: class extends Error {},
  reloadDefinition: vi.fn(),
  saveAutomation: vi.fn(),
}));

const MESSAGE =
  "No GitHub intake. Add an Automation with a GitHub label trigger.";

const manual: Intake = {
  automation: null,
  displayName: "Manual",
  provider: "nakara",
  event: "manual",
  enabled: true,
  detail: null,
  revision: null,
};
const github: Intake = {
  automation: "issue-labeled",
  displayName: "issue-labeled",
  provider: "github",
  event: "issue_labeled",
  enabled: true,
  detail: "factory:Harbor",
  revision: "a".repeat(64),
};
const telegram: Intake = {
  ...github,
  automation: "telegram-request",
  displayName: "Telegram request",
  provider: "telegram",
  event: "message",
  detail: "messages",
};

/** The Settings page's section, in a router that knows the Automations tab. */
const render = async (intake: Intake[]) => {
  const root = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => root,
    path: "/f/$slug/settings",
    component: () =>
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(WhereWorkComesFrom, { slug: "harbor", intake }),
      ),
  });
  const automations = createRoute({
    getParentRoute: () => root,
    path: "/f/$slug/automations",
  });
  const router = createRouter({
    routeTree: root.addChildren([settings, automations]),
    history: createMemoryHistory({ initialEntries: ["/f/harbor/settings"] }),
  });
  await router.load();
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
};
// The message's words, with the markup between them removed.
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("Where work comes from", () => {
  it("hides the message when a GitHub-label Automation brings work in", async () => {
    expect(hasGithubIntake([manual, github, telegram])).toBe(true);
    const html = await render([manual, github, telegram]);
    expect(html).toContain('aria-label="issue-labeled enabled"');
    expect(text(html)).not.toContain("No GitHub intake");
    expect(html).not.toContain('href="/f/harbor/automations"');
  });

  it("says there is no GitHub intake and links to the Automations tab", async () => {
    expect(hasGithubIntake([manual, telegram])).toBe(false);
    const html = await render([manual, telegram]);
    expect(text(html)).toContain(MESSAGE);
    const link = /<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/.exec(html);
    expect(link?.[1]).toBe("/f/harbor/automations");
    expect(link?.[2]).toBe("Add an Automation with a GitHub label trigger.");
  });
});
