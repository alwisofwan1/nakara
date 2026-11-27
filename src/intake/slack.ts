// Slack bridge over Socket Mode (inbound traffic only reaches this VPS through
// Cloudflare Tunnel, so no Events API webhook). Built like the Telegram bridge.
// - in: a request that mentions the bot (or a direct message) from a listed
//   member becomes a work item, in the factory a leading "@handle" names, else
//   the first factory; the request's thread is bound to that item, so every
//   later reply in it goes to the item (answering its question or the
//   requested changes) and never creates a second one
// - out: factory messages of a bound item are posted in its thread; a pending
//   spec approval gets Approve / Request changes buttons that call the same
//   path as the Inbox
// - notify: when a Work Item needs the Operator (a Spec or Question waits, its
//   Pull Request is ready to merge, it stops at its Budget or run limit), one
//   top-level message goes to the channel its factory's Settings name, if
//   that event's switch is on
// Members are listed per factory in the `filter.members` of its slack/message
// triggers; everyone else is ignored and logged. The bot and app tokens come
// from the secret store, never from Nakara's environment.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { Config } from "../config.ts";
import type { NeedsYou } from "../db.ts";
import type { Factory } from "../orchestrator/factory.ts";
import type { SlackChannels } from "../web/factories.ts";
import { itemView, stateLabel } from "../web/items.ts";
import { routeRequest, shorten, type TelegramFactories } from "./telegram.ts";

export type SlackApi = (
  method: string,
  body: Record<string, unknown>,
  /**
   * apps.connections.open takes the app-level token; the file upload methods
   * take form fields, not JSON.
   */
  mode?: "app" | "form",
) => Promise<Record<string, unknown>>;
/** Sends a file's bytes to the URL files.getUploadURLExternal gave. */
export type SlackUpload = (url: string, bytes: Uint8Array) => Promise<void>;

export function slackApi(botToken: string, appToken: string): SlackApi {
  return async (method, body, mode) => {
    const form = mode === "form";
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": form
          ? "application/x-www-form-urlencoded"
          : "application/json; charset=utf-8",
        authorization: `Bearer ${mode === "app" ? appToken : botToken}`,
      },
      body: form
        ? new URLSearchParams(
            Object.entries(body).map(([k, v]): [string, string] => [
              k,
              typeof v === "string" ? v : JSON.stringify(v),
            ]),
          )
        : JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    // Errors carry only Slack's error code, never the token.
    if (!json.ok)
      throw new Error(`slack ${method}: ${String(json.error ?? res.status)}`);
    return json;
  };
}

const slackUpload: SlackUpload = async (url, bytes) => {
  const res = await fetch(url, { method: "POST", body: bytes });
  if (!res.ok) throw new Error(`slack file upload: ${res.status}`);
};

/** The `message` and `app_mention` events this bridge reads. */
export interface SlackEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
}
/** A block_actions payload from the Approve / Request changes buttons. */
export interface SlackAction {
  type: string;
  user: { id: string };
  actions?: { action_id: string; value?: string }[];
  /** The message holding the buttons, so the press can replace them. */
  container?: { channel_id: string; message_ts: string };
  message?: { blocks?: { type: string }[] };
}
interface Thread {
  channel: string;
  ts: string;
}
/** The subset of WebSocket the bridge uses; tests pass a fake. */
export interface SlackSocket {
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

/** Block Kit caps a section's text at 3000 characters. */
const LIMIT = 2900;
/** Slack's own escaping, so a "<!channel>" in factory text stays text. */
const slackEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/**
 * Factory Markdown as Slack mrkdwn, escaped first: lists, links, bold and
 * headings. shortcut: code blocks are not exempt, so a "**" inside one turns
 * bold too; factory messages rarely carry code.
 */
export const mrkdwn = (s: string) =>
  slackEscape(s)
    .replace(/^(\s*)[-*] +/gm, "$1• ")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/^#{1,6} +(.+)$/gm, "*$1*");
const context = (text: string) => ({
  type: "context",
  elements: [{ type: "mrkdwn", text }],
});
/** Approve / Request changes for a pending spec approval. */
const buttons = (approvalId: number) => ({
  type: "actions",
  elements: [
    {
      type: "button",
      action_id: "approve",
      text: { type: "plain_text", text: "Approve" },
      style: "primary",
      value: String(approvalId),
    },
    {
      type: "button",
      action_id: "reject",
      text: { type: "plain_text", text: "Request changes" },
      value: String(approvalId),
    },
  ],
});
/** A leading bot mention, "<@U0BOT> fix the footer". */
const MENTION = /^<@[A-Z0-9]+>\s*/;

/**
 * The bridge for this config and secret store, or null when Slack intake is
 * switched off (NAKARA_SLACK_ENABLED=false) or a token is missing.
 */
export function slackBridge(
  config: Pick<Config, "slack">,
  secrets: Record<string, string>,
  factories: TelegramFactories,
): SlackBridge | null {
  const bot = secrets.NAKARA_SLACK_BOT_TOKEN;
  const app = secrets.NAKARA_SLACK_APP_TOKEN;
  if (!config.slack.enabled || !bot || !app) return null;
  return new SlackBridge(factories, slackApi(bot, app));
}

export class SlackBridge implements SlackChannels {
  private stopped = false;
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  private socket: SlackSocket | undefined;
  readonly factories: TelegramFactories;
  readonly api: SlackApi;
  readonly connect: (url: string) => SlackSocket;
  readonly upload: SlackUpload;
  constructor(
    factories: TelegramFactories,
    api: SlackApi,
    connect: (url: string) => SlackSocket = (url) =>
      new WebSocket(url) as unknown as SlackSocket,
    upload: SlackUpload = slackUpload,
  ) {
    this.factories = factories;
    this.api = api;
    this.connect = connect;
    this.upload = upload;
  }

  /** The default factory; the store is shared, and actions go to the item's own factory. */
  get factory(): Factory {
    return this.factories.default;
  }

  start(): void {
    const store = this.factory.store;
    // Start from now: no backlog of old messages on first run.
    if (!store.getKv("slack:cursor"))
      store.setKv("slack:cursor", String(store.lastMessageId()));
    if (!store.getKv("slack:evidence"))
      store.setKv("slack:evidence", String(store.lastEvidenceId()));
    this.timer = setInterval(() => void this.flush(), 5_000);
    store.attention.on("needsYou", this.onNeedsYou);
    void this.listen();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.factory.store.attention.off("needsYou", this.onNeedsYou);
    this.socket?.close();
  }

  private readonly onNeedsYou = (e: NeedsYou) => void this.notify(e);

  /**
   * Tell the Operator that a Work Item needs them: one top-level message in
   * the channel its factory's Settings name, when that event's switch is on.
   * A failure is logged and counted; it never reaches the item or the scheduler.
   */
  async notify(e: NeedsYou): Promise<void> {
    try {
      const store = this.factory.store;
      const item = store.item(e.itemId);
      if (!item) return;
      const { slackChannel, notify } =
        store.repos.factorySettings.notifications(item.factory_id);
      if (!slackChannel || !notify[e.event]) return;
      const factory = store.repos.factories.factoryById(item.factory_id);
      const publicUrl = this.factory.config.publicUrl;
      const headline = `${factory ? `${slackEscape(factory.name)} · ` : ""}*#${item.id}* ${slackEscape(item.title)}`;
      await this.api("chat.postMessage", {
        channel: slackChannel,
        // The notification line, then the message: what is needed and where.
        text: slackEscape(
          `${factory ? `${factory.name} · ` : ""}#${item.id} ${shorten(item.title, 150)}: ${shorten(e.what, 150)}`,
        ),
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${headline}\n${slackEscape(shorten(e.what, LIMIT - 500))}`,
            },
          },
          ...(publicUrl
            ? [
                context(
                  `<${publicUrl}/items/${item.id}|Open #${item.id} in Nakara>`,
                ),
              ]
            : []),
        ],
      });
    } catch (error) {
      this.failed("slack.notify_failed", error);
    }
  }

  /**
   * The channel ID of a "#name" Settings saves, from conversations.list; the
   * channel as given when it is already an ID, or the lookup fails or finds
   * nothing (chat.postMessage takes a name too).
   */
  async resolveChannel(channel: string): Promise<string> {
    const name = channel.trim();
    if (!name.startsWith("#")) return name;
    try {
      let cursor = "";
      // A workspace with more than 10 pages of channels keeps the name.
      for (let page = 0; page < 10; page++) {
        const res = (await this.api(
          "conversations.list",
          {
            types: "public_channel,private_channel",
            exclude_archived: "true",
            limit: "1000",
            ...(cursor ? { cursor } : {}),
          },
          "form",
        )) as {
          channels?: { id: string; name: string }[];
          response_metadata?: { next_cursor?: string };
        };
        const found = res.channels?.find((c) => c.name === name.slice(1));
        if (found) return found.id;
        cursor = res.response_metadata?.next_cursor ?? "";
        if (!cursor) break;
      }
    } catch (error) {
      this.factory.telemetry.log.warn("slack.channel_unresolved", {
        channel: name,
        error,
      });
    }
    return name;
  }

  /** Post factory messages written since the last flush in their item's thread. */
  async flush(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const store = this.factory.store;
    try {
      for (const m of store.factoryMessagesAfter(
        Number(store.getKv("slack:cursor") ?? 0),
      )) {
        const thread = this.thread(m.item_id);
        if (thread) {
          // biome-ignore lint/style/noNonNullAssertion: A message belongs to an item.
          const item = store.item(m.item_id)!;
          const approval = store
            .approvals(item.id)
            .find(
              (a) =>
                a.status === "pending" &&
                a.kind === "spec" &&
                !store.getKv(`slack:approval:${a.id}`),
            );
          const state = stateLabel(
            item,
            itemView(item, store.runs(item.id), store.approvals(item.id)),
          );
          const publicUrl = this.factory.config.publicUrl;
          const pr = item.pr_url?.match(/\/pull\/(\d+)/)?.[1];
          const owner =
            this.factories.factories.length > 1
              ? this.factories.forItem(item.id)?.record?.name
              : undefined;
          const meta = [
            `${owner ? `${slackEscape(owner)} · ` : ""}*#${item.id}* ${slackEscape(item.title)}`,
            slackEscape(state),
            publicUrl && `<${publicUrl}/items/${item.id}|Open in Nakara>`,
            item.pr_url &&
              `<${item.pr_url}|${pr ? `PR #${pr}` : "Pull request"}>`,
          ].filter(Boolean);
          const body = mrkdwn(m.body.trim());
          // biome-ignore lint/style/noNonNullAssertion: split always yields a first line.
          const first = m.body.trim().split("\n")[0]!;
          await this.post(thread, {
            // The notification line: item, state and the body's first line.
            text: slackEscape(`#${item.id} · ${state}: ${shorten(first, 150)}`),
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text:
                    body.length > LIMIT
                      ? `${body.slice(0, LIMIT)}…\n_Truncated; the full message is in Nakara._`
                      : body || "_(empty)_",
                },
              },
              context(meta.join(" · ")),
              ...(approval ? [buttons(approval.id)] : []),
            ],
          });
          if (approval) store.setKv(`slack:approval:${approval.id}`, "1");
        }
        store.setKv("slack:cursor", String(m.id));
      }
      await this.flushEvidence();
    } catch (e) {
      this.failed("slack.send_failed", e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Post new proof in its item's thread: one message per run, the screenshots
   * attached and each criterion listed. Each run is tried once: the PR comment
   * keeps the proof if Slack refuses it (no files:write scope, say).
   */
  private async flushEvidence(): Promise<void> {
    const store = this.factory.store;
    const rows = store.evidenceAfter(
      Number(store.getKv("slack:evidence") ?? 0),
    );
    const runs = Map.groupBy(rows, (r) => r.run_id);
    for (const group of runs.values()) {
      // biome-ignore lint/style/noNonNullAssertion: groupBy makes no empty groups.
      const last = group.at(-1)!;
      const thread = this.thread(last.item_id);
      if (thread) {
        try {
          const files: { id: string; title: string }[] = [];
          for (const [i, row] of group.entries()) {
            const bytes = await readFile(row.file);
            const { upload_url, file_id } = await this.api(
              "files.getUploadURLExternal",
              { filename: basename(row.file), length: String(bytes.length) },
              "form",
            );
            await this.upload(String(upload_url), bytes);
            files.push({
              id: String(file_id),
              title: `${i + 1}. ${shorten(row.criterion, 200)}`,
            });
          }
          await this.api(
            "files.completeUploadExternal",
            {
              files,
              channel_id: thread.channel,
              thread_ts: thread.ts,
              initial_comment: [
                `*Proof* for #${last.item_id}: ${group.length} screenshot${group.length === 1 ? "" : "s"} of the running change.`,
                ...group.map((r, i) => `${i + 1}. ${slackEscape(r.criterion)}`),
              ].join("\n"),
            },
            "form",
          );
        } catch (e) {
          this.failed("slack.evidence_failed", e);
        }
      }
      store.setKv("slack:evidence", String(last.id));
    }
  }

  private async listen(): Promise<void> {
    while (!this.stopped) {
      try {
        const { url } = await this.api("apps.connections.open", {}, "app");
        await new Promise<void>((resolve) => {
          const socket = this.connect(String(url));
          this.socket = socket;
          socket.onmessage = (e) => void this.receive(socket, String(e.data));
          socket.onerror = () => socket.close();
          socket.onclose = () => resolve();
        });
      } catch (e) {
        this.failed("intake.poll_failed", e);
      }
      // Slack asks clients to reconnect; a short pause keeps a failure from spinning.
      if (!this.stopped) await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  /** One Socket Mode envelope: acknowledged first, then handled. */
  async receive(socket: SlackSocket, raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as {
      type: string;
      envelope_id?: string;
      payload?: { event?: SlackEvent } & SlackAction;
    };
    if (envelope.envelope_id)
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    this.factory.telemetry.metrics.lastPoll.set(
      { source: "slack" },
      Date.now() / 1000,
    );
    if (envelope.type === "disconnect") return socket.close();
    try {
      if (envelope.type === "events_api" && envelope.payload?.event)
        await this.handleEvent(envelope.payload.event);
      if (envelope.type === "interactive" && envelope.payload)
        await this.handleAction(envelope.payload);
    } catch (e) {
      this.failed("slack.handle_failed", e);
    }
  }

  async handleEvent(e: SlackEvent): Promise<void> {
    // Edits, joins and bot posts (our own included) are not requests; a reply
    // also sent to the channel (thread_broadcast) is.
    if ((e.subtype && e.subtype !== "thread_broadcast") || e.bot_id || !e.user)
      return;
    // Slack escapes only &, < and > in message text; &amp; goes last so "&amp;gt;" stays "&gt;".
    const text = e.text
      ?.replace(MENTION, "")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
      .trim();
    if (!text) return;
    const store = this.factory.store;
    const inThread = e.thread_ts !== undefined && e.thread_ts !== e.ts;
    const creates =
      !inThread &&
      (e.type === "app_mention" ||
        (e.type === "message" && e.channel_type === "im"));
    // A reply that mentions the bot arrives as both events; the message one handles it.
    if (!(creates || (inThread && e.type === "message"))) return;
    // Slack redelivers an event it thinks was not acknowledged.
    const seen = `slack:seen:${e.channel}:${e.ts}`;
    if (store.getKv(seen)) return;
    store.setKv(seen, "1");

    if (inThread) {
      // biome-ignore lint/style/noNonNullAssertion: inThread checked thread_ts.
      const bound = store.getKv(`slack:thread:${e.channel}:${e.thread_ts!}`);
      if (!bound)
        return void this.factory.telemetry.log.info("slack.unbound_thread", {
          channel: e.channel,
          thread_ts: e.thread_ts,
        });
      const itemId = Number(bound);
      const factory = this.factories.forItem(itemId) ?? this.factory;
      if (!this.allowed(factory, e.user)) return this.ignored(e);
      const approval = store
        .approvals(itemId)
        .find(
          (a) =>
            a.status === "pending" &&
            (a.kind === "question" || store.getKv(`slack:reject:${a.id}`)),
        );
      if (approval)
        factory.answerApproval(approval.id, { approved: false, answer: text });
      else factory.sendMessage(itemId, text);
      return this.post(
        { channel: e.channel, ts: e.thread_ts as string },
        `Sent to #${itemId}.`,
      );
    }

    // Strangers learn nothing, not even the factory handles.
    if (!this.factories.factories.some((f) => this.allowed(f, e.user)))
      return this.ignored(e);
    const thread = { channel: e.channel, ts: e.ts };
    const routed = routeRequest(this.factories, text, "slack");
    if ("reply" in routed) return this.post(thread, routed.reply);
    const { factory, request, automation } = routed;
    if (!this.allowed(factory, e.user)) return this.ignored(e);
    const item = factory.createWorkItem({
      // biome-ignore lint/style/noNonNullAssertion: split always yields a first line.
      title: shorten(request.split("\n")[0]!, 80),
      request,
      requester: e.user,
      source: "slack",
      sourceRef: `slack:${e.channel}:${e.ts}`,
      repo: null,
      automation,
    });
    store.setKv(`slack:thread:${e.channel}:${e.ts}`, String(item.id));
    store.setKv(`slack:item:${item.id}`, JSON.stringify(thread));
    await this.post(
      thread,
      `Created #${item.id}${this.factories.factories.length > 1 ? ` in ${factory.record?.name}` : ""}. Reply in this thread to add to it.`,
    );
  }

  /** Approve / Request changes, by a listed member of the item's factory. */
  async handleAction(p: SlackAction): Promise<void> {
    const action = p.actions?.[0];
    if (p.type !== "block_actions" || !action?.value) return;
    const store = this.factory.store;
    const approval = store.approval(Number(action.value));
    if (!approval) return;
    const factory = this.factories.forItem(approval.item_id) ?? this.factory;
    if (!this.allowed(factory, p.user.id))
      return this.ignored({ user: p.user.id });
    const thread = this.thread(approval.item_id);
    if (!thread) return;
    if (approval.status !== "pending")
      return this.post(thread, "This request is no longer pending.");
    const approve = action.action_id === "approve";
    if (approve)
      factory.answerApproval(approval.id, { approved: true, answer: "" });
    else store.setKv(`slack:reject:${approval.id}`, "1");
    const outcome = approve
      ? `:white_check_mark: Approved by <@${p.user.id}>`
      : `:pencil2: Changes requested by <@${p.user.id}>`;
    // The buttons give way to who pressed them; with no message to edit, the thread says it.
    if (p.container && p.message?.blocks)
      await this.api("chat.update", {
        channel: p.container.channel_id,
        ts: p.container.message_ts,
        text: `#${approval.item_id} · ${approve ? "Spec approved" : "Changes requested"}`,
        blocks: [
          ...p.message.blocks.filter((b) => b.type !== "actions"),
          context(outcome),
        ],
      });
    else
      await this.post(
        thread,
        `#${approval.item_id}: ${approve ? "spec approved." : "changes requested."}`,
      );
    if (!approve)
      await this.post(thread, "What should change? Reply in this thread.");
  }

  /** Whether `user` is listed in a slack/message trigger of `factory`. */
  private allowed(factory: Factory, user: string | undefined): boolean {
    return Boolean(
      user &&
        factory.definition?.automations.some(
          (a) =>
            a.frontmatter.enabled &&
            a.frontmatter.triggers.some(
              (t) =>
                t.provider === "slack" &&
                t.event === "message" &&
                (t.filter?.members as string[] | undefined)?.includes(user),
            ),
        ),
    );
  }

  private ignored(e: Pick<SlackEvent, "user"> & Partial<SlackEvent>): void {
    this.factory.telemetry.log.info("slack.unlisted_member", {
      user: e.user,
      channel: e.channel,
      message: `message from Slack member ${e.user}; add it to a slack/message trigger's filter.members to trust it`,
    });
  }

  private thread(itemId: number): Thread | undefined {
    const v = this.factory.store.getKv(`slack:item:${itemId}`);
    return v ? (JSON.parse(v) as Thread) : undefined;
  }

  /** Plain text is escaped here; a prepared message comes escaped. */
  private async post(
    thread: Thread,
    message: string | { text: string; blocks: unknown[] },
  ): Promise<void> {
    await this.api("chat.postMessage", {
      channel: thread.channel,
      thread_ts: thread.ts,
      ...(typeof message === "string"
        ? { text: slackEscape(message) }
        : message),
    });
  }

  /** Count and log a failed connection or delivery; the error never holds a token (see slackApi). */
  private failed(event: string, error: unknown): void {
    const { log, metrics } = this.factory.telemetry;
    metrics.pollErrors.inc({ source: "slack" });
    log.error(event, { source: "slack", error });
  }
}
