// Telegram bridge over long polling (inbound traffic only reaches this VPS
// through Cloudflare Tunnel, so no webhook). Only one chat is trusted.
// - out: every factory message is sent to the chat with the item's state label
//   and a link to its Work Item page; a pending approval gets
//   Approve / Request changes buttons; with more than one factory it starts
//   with the item's factory name
// - in: a reply to a bot message goes to that item (answering its open
//   question or the requested changes); other text becomes a work item when an
//   automation has a telegram/message trigger, in the factory a leading
//   "@handle" names, else the first factory
import type { Factory } from "../orchestrator/factory.ts";
import type { FactoryRegistry } from "../orchestrator/registry.ts";
import { itemView, stateLabel } from "../web/items.ts";

export type TelegramApi = (
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export function telegramApi(token: string): TelegramApi {
  return async (method, body, signal) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? null,
    });
    const json = (await res.json()) as {
      ok: boolean;
      result?: unknown;
      description?: string;
    };
    // The URL holds the token; errors carry only Telegram's description.
    if (!json.ok)
      throw new Error(`telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  };
}

interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { username?: string; first_name?: string };
  text?: string;
  reply_to_message?: { message_id: number };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage };
}
/** What a bot message points at, keyed by its message_id. */
interface Link {
  item: number;
  approval?: number;
  /** The "what should change?" prompt after Request changes. */
  reject?: boolean;
}

const HELP =
  'Send a request as plain text to create a work item. To message an item or answer its question, reply to its notification or send "#<id> <text>". Spec approvals come with buttons.';
const LIMIT = 3500;
export const shorten = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`; // Telegram allows 4096 characters per message.

/** "@handle request" sends a new request to that handle's factory. */
const HANDLE = /^@([\w-]+)(?:\s+([\s\S]+))?$/;

/** The registered factories, the default first; see FactoryRegistry. */
export type TelegramFactories = Pick<
  FactoryRegistry,
  "factories" | "default" | "byHandle" | "forItem"
>;

/**
 * The factory a new chat request goes to (a leading "@handle", else the
 * default), the request without the handle and the automation whose
 * `provider`/message trigger takes it; or the reply that says why not.
 */
export function routeRequest(
  factories: TelegramFactories,
  text: string,
  provider: string,
):
  | { factory: Factory; request: string; automation: string }
  | { reply: string } {
  const addressed = HANDLE.exec(text);
  const factory = addressed
    ? // biome-ignore lint/style/noNonNullAssertion: The pattern captures a handle.
      factories.byHandle(addressed[1]!)
    : factories.default;
  if (!factory) {
    const handles = factories.factories
      .map(({ record }) => {
        const slug =
          record?.slug.toLowerCase() === record?.foreman_handle.toLowerCase()
            ? ""
            : ` or @${record?.slug}`;
        return `@${record?.foreman_handle}${slug} (${record?.name})`;
      })
      .join(", ");
    return {
      reply: `Unknown handle @${addressed?.[1]}. Start a request with one of ${handles}, or with no handle for ${factories.default.record?.name}.`,
    };
  }
  const request = addressed ? addressed[2] : text;
  if (!request)
    return {
      reply: `Send the request after the handle: "@${addressed?.[1]} <request>".`,
    };
  const automation = factory.definition?.automations.find(
    (a) =>
      a.frontmatter.enabled &&
      a.frontmatter.triggers.some(
        (t) => t.provider === provider && t.event === "message",
      ),
  );
  if (!automation)
    return {
      reply:
        factories.factories.length > 1
          ? `${factory.record?.name} has no automation with a ${provider}/message trigger.`
          : `Reply to a notification to message its work item. New requests need an automation with a ${provider}/message trigger.`,
    };
  return { factory, request, automation: automation.name };
}

export class TelegramBridge {
  private abort = new AbortController();
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  readonly factories: TelegramFactories;
  readonly api: TelegramApi;
  readonly chatId: string;
  constructor(factories: TelegramFactories, api: TelegramApi, chatId: string) {
    this.factories = factories;
    this.api = api;
    this.chatId = chatId;
  }

  /**
   * The default factory. The store is shared, and it passes actions on an
   * item to the item's own factory.
   */
  get factory(): Factory {
    return this.factories.default;
  }

  start(): void {
    const store = this.factory.store;
    // Start from now: no backlog of old messages on first run.
    if (!store.getKv("tg:cursor"))
      store.setKv("tg:cursor", String(store.lastMessageId()));
    if (this.chatId) this.timer = setInterval(() => void this.flush(), 5_000);
    void this.listen();
  }

  stop(): void {
    clearInterval(this.timer);
    this.abort.abort();
  }

  /** Send factory messages written since the last flush. */
  async flush(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const store = this.factory.store;
    try {
      for (const m of store.factoryMessagesAfter(
        Number(store.getKv("tg:cursor") ?? 0),
      )) {
        // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
        const item = store.item(m.item_id)!;
        const approval = store
          .approvals(item.id)
          .find(
            (a) =>
              a.status === "pending" && !store.getKv(`tg:approval:${a.id}`),
          );
        const buttons =
          approval?.kind === "spec"
            ? {
                inline_keyboard: [
                  [
                    { text: "Approve", callback_data: `a:${approval.id}:y` },
                    {
                      text: "Request changes",
                      callback_data: `a:${approval.id}:n`,
                    },
                  ],
                ],
              }
            : undefined;
        const question = approval?.kind === "question";
        const hint = question
          ? `\n\n(Reply to this message, or send "#${item.id} <answer>".)`
          : "";
        const state = stateLabel(
          item,
          itemView(item, store.runs(item.id), store.approvals(item.id)),
        );
        const publicUrl = this.factory.config.publicUrl;
        const page = publicUrl ? `\n${publicUrl}/items/${item.id}` : "";
        const owner =
          this.factories.factories.length > 1
            ? this.factories.forItem(item.id)?.record?.name
            : undefined;
        const prefix = owner ? `[${owner}] ` : "";
        const text = `${prefix}#${item.id} ${item.title}\n${state}${page}\n\n${m.body.slice(0, LIMIT)}${hint}`;
        const sent = (await this.api("sendMessage", {
          chat_id: this.chatId,
          text,
          reply_markup:
            buttons ?? (question ? { force_reply: true } : undefined),
        })) as TgMessage;
        this.link(sent.message_id, { item: item.id, approval: approval?.id });
        if (approval)
          store.setKv(`tg:approval:${approval.id}`, String(sent.message_id));
        store.setKv("tg:cursor", String(m.id));
      }
    } catch (e) {
      this.failed("telegram.send_failed", e);
    } finally {
      this.busy = false;
    }
  }

  private async listen(): Promise<void> {
    const store = this.factory.store;
    while (!this.abort.signal.aborted) {
      try {
        const offset = Number(store.getKv("tg:offset") ?? 0);
        const updates = (await this.api(
          "getUpdates",
          {
            offset,
            timeout: 50,
            allowed_updates: ["message", "callback_query"],
          },
          this.abort.signal,
        )) as TgUpdate[];
        this.factory.telemetry.metrics.lastPoll.set(
          { source: "telegram" },
          Date.now() / 1000,
        );
        for (const u of updates) {
          store.setKv("tg:offset", String(u.update_id + 1));
          await this.handle(u).catch((e: unknown) =>
            this.say(`Error: ${String(e).slice(0, 500)}`),
          );
        }
      } catch (e) {
        if (this.abort.signal.aborted) return;
        this.failed("intake.poll_failed", e);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  }

  async handle(u: TgUpdate): Promise<void> {
    const chat = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
    if (!this.chatId)
      return void this.factory.telemetry.log.info("telegram.untrusted_chat", {
        chat,
        message: `message from chat ${chat}; set NAKARA_TELEGRAM_CHAT_ID to trust it`,
      });
    if (String(chat) !== this.chatId) return;

    if (u.callback_query) {
      const [, id, yes] =
        /^a:(\d+):([yn])$/.exec(u.callback_query.data ?? "") ?? [];
      await this.api("answerCallbackQuery", {
        callback_query_id: u.callback_query.id,
      });
      if (!id) return;
      const approval = this.factory.store.approval(Number(id));
      if (approval?.status !== "pending")
        return this.say("This request is no longer pending.");
      // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
      const msg = u.callback_query.message!;
      await this.api("editMessageReplyMarkup", {
        chat_id: this.chatId,
        message_id: msg.message_id,
        reply_markup: { inline_keyboard: [] },
      });
      if (yes === "y") {
        this.factory.answerApproval(approval.id, {
          approved: true,
          answer: "",
        });
        return this.say(`#${approval.item_id}: spec approved.`);
      }
      const ask = (await this.api("sendMessage", {
        chat_id: this.chatId,
        text: `#${approval.item_id}: what should change? Reply to this message.`,
        reply_markup: { force_reply: true },
      })) as TgMessage;
      return this.link(ask.message_id, {
        item: approval.item_id,
        approval: approval.id,
        reject: true,
      });
    }

    const m = u.message;
    const text = m?.text?.trim();
    if (!m || !text) return;
    // "#12 text" addresses an item without replying.
    const tagged = /^#(\d+)\s+([\s\S]+)$/.exec(text);
    const replied =
      m.reply_to_message && this.links(m.reply_to_message.message_id);
    if (m.reply_to_message && !replied)
      this.factory.telemetry.log.info("telegram.unknown_reply", {
        message_id: m.reply_to_message.message_id,
      });
    const pending =
      tagged &&
      this.factory.store
        .approvals(Number(tagged[1]))
        .find((a) => a.status === "pending" && a.kind === "question");
    const link: Link | undefined =
      replied ||
      (tagged ? { item: Number(tagged[1]), approval: pending?.id } : undefined);
    // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
    const body = replied || !tagged ? text : tagged[2]!;
    if (link) {
      const approval = link.approval
        ? this.factory.store.approval(link.approval)
        : undefined;
      if (
        approval?.status === "pending" &&
        (link.reject || approval.kind === "question")
      )
        this.factory.answerApproval(approval.id, {
          approved: false,
          answer: body,
        });
      else this.factory.sendMessage(link.item, body);
      return this.say(`Sent to #${link.item}.`);
    }

    // Commands like /start (sent when the bot is first opened) are not requests.
    if (text.startsWith("/")) return this.say(HELP);
    const routed = routeRequest(this.factories, text, "telegram");
    if ("reply" in routed) return this.say(routed.reply);
    const { factory, request, automation } = routed;
    const item = factory.createWorkItem({
      // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
      title: shorten(request.split("\n")[0]!, 80),
      request,
      requester: m.from?.username ?? m.from?.first_name ?? null,
      source: "telegram",
      sourceRef: `telegram:${chat}:${m.message_id}`,
      repo: null,
      automation,
    });
    const ack = (await this.api("sendMessage", {
      chat_id: this.chatId,
      text: `Created #${item.id}${this.factories.factories.length > 1 ? ` in ${factory.record?.name}` : ""}. Reply here to add to it.`,
    })) as TgMessage;
    this.link(ack.message_id, { item: item.id });
  }

  /** Count and log a failed poll or delivery; the error never holds the token (see telegramApi). */
  private failed(event: string, error: unknown): void {
    const { log, metrics } = this.factory.telemetry;
    metrics.pollErrors.inc({ source: "telegram" });
    log.error(event, { source: "telegram", error });
  }

  private async say(text: string): Promise<void> {
    await this.api("sendMessage", { chat_id: this.chatId, text });
  }

  private link(messageId: number, link: Link): void {
    this.factory.store.setKv(`tg:m:${messageId}`, JSON.stringify(link));
  }

  private links(messageId: number): Link | undefined {
    const v = this.factory.store.getKv(`tg:m:${messageId}`);
    return v ? (JSON.parse(v) as Link) : undefined;
  }
}
