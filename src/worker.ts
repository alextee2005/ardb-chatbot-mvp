/**
 * Worker entry point.
 *
 * The webhook acknowledges Telegram immediately and does the real work in
 * `ctx.waitUntil`. This is not an optimisation: Telegram retries a webhook it
 * considers slow, and a retry of a question would file a second ticket. Fast
 * 200 plus the `processed_updates` dedupe are the two halves of that defence.
 *
 * Waiting on `fetch` does not count against the Worker CPU limit, so the
 * Claude call inside `waitUntil` is comfortable even on the free plan.
 */

import knowledgeJson from "../knowledge/ardb-knowledge.json";

import { Store } from "./adapters/store.js";
import { TelegramClient } from "./adapters/telegram.js";
import { loadConfig, ConfigError, type Env } from "./config.js";
import { isPlaceholder, type KnowledgeBase } from "./core/knowledge.js";
import { CUSTOMER_MESSAGES } from "./core/messages.js";
import {
  handleQuestion,
  handleStart,
  type CustomerContext,
} from "./handlers/customer.js";
import {
  handleCallback,
  handleModeratorMessage,
  type CallbackQuery,
  type ModeratorContext,
} from "./handlers/moderator.js";
import type { TelegramMessage } from "./adapters/telegram.js";

const knowledge = knowledgeJson as KnowledgeBase;

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage & { chat: { id: number; type: string } };
  callback_query?: CallbackQuery;
}

const WEBHOOK_PATH = "/telegram/webhook";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        knowledgeVersion: knowledge.version,
        knowledgeEntries: knowledge.entries.length,
        knowledgePlaceholder: isPlaceholder(knowledge),
      });
    }

    if (url.pathname !== WEBHOOK_PATH) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "configuration error",
          detail: error instanceof ConfigError ? error.message : String(error),
        }),
      );
      // 500, not 200: this is worth a Telegram retry, because the usual cause
      // is a secret that has just been set and not yet propagated.
      return new Response("Configuration error", { status: 500 });
    }

    // The only thing proving this request came from Telegram.
    const presented = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!timingSafeEqual(presented, config.webhookSecret)) {
      return new Response("Forbidden", { status: 403 });
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    ctx.waitUntil(processUpdate(update, config, ctx));
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;

async function processUpdate(
  update: TelegramUpdate,
  config: ReturnType<typeof loadConfig>,
  ctx: ExecutionContext,
): Promise<void> {
  const store = new Store(config.databaseUrl);
  const telegram = new TelegramClient(config.telegramToken);

  try {
    const fresh = await store.claimUpdate(update.update_id);
    if (!fresh) return; // A Telegram retry of something already handled.

    if (update.callback_query) {
      // Only taps on cards in the moderator group count. A card cannot be seen
      // outside that group, so this is also the authorization check.
      if (update.callback_query.message?.chat.id !== config.moderatorChatId) return;
      const moderatorCtx: ModeratorContext = {
        telegram,
        store,
        moderatorChatId: config.moderatorChatId,
      };
      await handleCallback(moderatorCtx, update.callback_query);
      return;
    }

    const message = update.message;
    if (!message) return;

    if (message.chat.id === config.moderatorChatId) {
      await handleModeratorMessage(
        { telegram, store, moderatorChatId: config.moderatorChatId },
        message,
      );
      return;
    }

    // Everything else must be a customer. Group chats the bot has been added
    // to are ignored: this bot answers individuals.
    if (message.chat.type !== "private") return;

    const customerCtx: CustomerContext = {
      telegram,
      store,
      knowledge,
      claude: {
        apiKey: config.anthropicApiKey,
        model: config.claudeModel,
        effort: config.claudeEffort,
      },
      moderatorChatId: config.moderatorChatId,
      rateLimitPerMinute: config.rateLimitPerMinute,
    };

    const text = message.text?.trim();

    if (text?.startsWith("/start")) {
      await handleStart(customerCtx, message);
      return;
    }
    if (text?.startsWith("/")) return; // Unknown command; stay quiet.

    if (!text) {
      // A photo, voice note, sticker or document.
      await telegram.sendMessage({
        chatId: message.chat.id,
        text: CUSTOMER_MESSAGES.unsupportedMessage,
      });
      return;
    }

    await handleQuestion(customerCtx, message);

    // Cheap, and keeps the dedupe table from growing without bound. Detached
    // so a slow DELETE never delays the answer to a customer.
    ctx.waitUntil(store.pruneProcessedUpdates());
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "unhandled error processing update",
        updateId: update.update_id,
        detail: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );

    // Tell the customer something broke rather than leaving them waiting for
    // an answer that is never coming.
    const chatId = update.message?.chat.id;
    if (chatId !== undefined && chatId !== config.moderatorChatId) {
      await telegram
        .sendMessage({ chatId, text: CUSTOMER_MESSAGES.internalError })
        .catch(() => undefined);
    }
  }
}

/**
 * Constant-time string comparison, so a wrong secret cannot be discovered one
 * byte at a time by timing the response.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
