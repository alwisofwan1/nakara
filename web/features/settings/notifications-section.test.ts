import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  type Notifications,
  NotificationsSection,
} from "./notifications-section";

// The API module reads the page's runtime config; rendering never saves.
vi.mock("../../lib/api", () => ({
  factorySettingsQuery: vi.fn(),
  saveNotifications: vi.fn(),
}));
vi.mock("../../app/toast", () => ({ useToast: () => vi.fn() }));
// Rendered without a router: the Setup link is a plain anchor.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: unknown }) =>
    createElement("a", { href: to }, children as string),
}));

const ON = { approvals: true, handoff: true, paused: true };
const section = (notifications: Partial<Notifications> = {}) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(NotificationsSection, {
        slug: "harbor",
        notifications: {
          slackChannel: null,
          notify: ON,
          slackConnected: true,
          ...notifications,
        },
      }),
    ),
  );

/** Each switch's label and whether it is on, in order. */
const switches = (html: string) =>
  [...html.matchAll(/<label class="switch-field">(.*?)<\/label>/g)].map(
    ([, label = ""]) => ({
      label: label.replace(/<[^>]+>/g, "").trim(),
      on: /checked=""/.test(label),
    }),
  );

describe("Notifications section", () => {
  it("shows the Slack channel input and the three switches, on when unsaved", () => {
    const html = section();
    expect(html).toContain("Slack channel");
    expect(html).toContain('placeholder="#channel"');
    expect(html).toContain("Notify me when");
    expect(switches(html)).toEqual([
      { label: "A Spec or Question waits", on: true },
      { label: "A Pull Request is ready to merge", on: true },
      { label: "A Work Item pauses at its Budget", on: true },
    ]);
    expect(html).not.toContain("Slack is not connected yet");
  });

  it("shows the saved channel and switches", () => {
    const html = section({
      slackChannel: "C0RELEASES",
      notify: { approvals: true, handoff: false, paused: false },
    });
    expect(html).toContain('value="C0RELEASES"');
    expect(switches(html).map((s) => s.on)).toEqual([true, false, false]);
  });

  it("points to Setup when the Slack bridge is off", () => {
    expect(section({ slackConnected: false })).toContain(
      'Slack is not connected yet. See <a href="/setup">Setup</a>.',
    );
  });
});
