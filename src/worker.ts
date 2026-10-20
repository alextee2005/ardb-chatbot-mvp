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

// The built corpus, not the raw archive: `tools/build_corpus.py` turns one
// into the other, and only the corpus is single-language and reviewed.
import knowledgeJson from "../knowledge/corpus/ardb-corpus.json";

import { draftResponse, type DraftResult } from "./adapters/claude.js";
import { dispatchDraft } from "./adapters/github-dispatch.js";
import { draftWithWorkersAi } from "./adapters/workers-ai.js";
import { Store } from "./adapters/store.js";
import { TelegramClient } from "./adapters/telegram.js";
import { loadConfig, ConfigError, type Env } from "./config.js";
import type { DraftRequest } from "./core/draft.js";
import type { Ticket } from "./core/tickets.js";
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
import { draftAndUpdateCard } from "./handlers/drafting.js";
import { handleCustomerCallback } from "./handlers/customer-callbacks.js";
import { runEngagementSweep } from "./handlers/engagement.js";
import { runSlaSweep } from "./handlers/sla.js";
import { scheduledWork } from "./core/schedule.js";
import type { TelegramMessage } from "./adapters/telegram.js";

const knowledge = knowledgeJson as KnowledgeBase;

/**
 * What happens once a ticket and its moderator card exist.
 *
 * Three shapes, one signature. Inline drafting does the work on the webhook;
 * the GitHub route hands the ticket to a workflow that does the same work in
 * another runtime; moderator-only does nothing and leaves a person to write
 * the answer.
 *
 * `config.draftProvider` is already the *effective* provider -- loadConfig
 * resolves one it cannot run down to "none" -- so nothing here re-checks for
 * a missing key, binding or token.
 */
function selectOnTicket(
  config: ReturnType<typeof loadConfig>,
  telegram: TelegramClient,
  store: Store,
): ((ticket: Ticket) => Promise<void>) | null {
  const inline = (draft: (request: DraftRequest) => Promise<DraftResult>) => {
    const ctx = {
      telegram,
      store,
      knowledge,
      moderatorChatId: config.moderatorChatId,
      draft,
    };
    return (ticket: Ticket) => draftAndUpdateCard(ctx, ticket);
  };

  switch (config.draftProvider) {
    case "claude":
      return inline((request) =>
        draftResponse(
          {
            apiKey: config.anthropicApiKey!,
            model: config.claudeModel,
            effort: config.claudeEffort,
          },
          request,
        ),
      );

    case "workers-ai":
      return inline((request) =>
        draftWithWorkersAi({ binding: config.ai!, model: config.workersAiModel }, request),
      );

    case "github":
      // The card stays as posted -- question visible, Edit and Reject live --
      // until the workflow fills it in. A moderator who answers before the
      // draft lands simply resolves the ticket, and the drafting job then
      // finds it resolved and leaves it alone.
      return async (ticket: Ticket) => {
        const dispatched = await dispatchDraft(config.githubDispatch!, ticket.id);
        if (dispatched.ok) return;

        // A dispatch that failed silently would leave a card that never
        // fills in and no explanation anywhere. Put the reason on the card
        // itself, where the person waiting for the draft is looking.
        console.error(
          JSON.stringify({
            level: "error",
            msg: "draft dispatch failed",
            ticketId: ticket.id,
            detail: dispatched.error,
          }),
        );
        await draftAndUpdateCard(
          {
            telegram,
            store,
            knowledge,
            moderatorChatId: config.moderatorChatId,
            draft: async () => ({ ok: false, error: dispatched.error }),
          },
          ticket,
        );
      };

    case "none":
      return null;
  }
}

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
      // Optional and opt-in via ?schema=1, because it needs DATABASE_URL and
      // /health must keep answering on a Worker with no secrets set at all.
      let schema: { ok: boolean; missing: string[] } | { error: string } | undefined;
      if (url.searchParams.get("schema") === "1" && env.DATABASE_URL?.trim()) {
        try {
          schema = await new Store(env.DATABASE_URL).schemaStatus();
        } catch (error) {
          schema = { error: error instanceof Error ? error.message : String(error) };
        }
      }

      return Response.json({
        ok: true,
        ...(schema ? { schema } : {}),
        knowledgeVersion: knowledge.version,
        knowledgeEntries: knowledge.entries.length,
        knowledgePlaceholder: isPlaceholder(knowledge),
        // Whether questions get a suggested answer, or go to the group for a
        // moderator to write. Reported because the symptom of a missing key
        // is subtle -- cards arrive, just without drafts.
        // Reported because the symptom of a drafting misconfiguration is
        // subtle: cards still arrive, just without suggested answers. Read
        // from env rather than loadConfig so /health answers on a Worker with
        // no secrets set at all.
        drafting: {
          provider: env.DRAFT_PROVIDER ?? "workers-ai",
          claudeKey: Boolean(env.ANTHROPIC_API_KEY?.trim()),
          workersAi: Boolean(env.AI),
        },
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

  /**
   * Cron Trigger: one schedule, every minute, dispatched by the clock.
   *
   * `scheduledWork` decides what this minute is for -- see the comment there
   * for why one trigger rather than three. All three sweeps can be due on the
   * same minute and each is independent, so they run in sequence and a
   * failure in one does not stop the others.
   *
   * Errors are caught rather than thrown. A failed sweep must not retry in a
   * tight loop, and the next run picks up the same work anyway: every step
   * claims its work in SQL, so a repeat is harmless.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "scheduled run skipped: configuration error",
          cron: event.cron,
          detail: error instanceof ConfigError ? error.message : String(error),
        }),
      );
      return;
    }

    const telegram = new TelegramClient(config.telegramToken);
    const store = new Store(config.databaseUrl);
    const due = scheduledWork(new Date(event.scheduledTime));

    /** Run one sweep, logging rather than throwing. */
    const guard = async (name: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            msg: `${name} failed`,
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    };

    ctx.waitUntil(
      (async () => {
        if (due.engagement) {
          await guard("engagement sweep", async () => {
            const summary = await runEngagementSweep({
              telegram,
              store,
              followupMinutes: config.followupMinutes,
              idleMinutes: config.conversationIdleMinutes,
            });
            if (summary.followupsAsked > 0 || summary.surveysSent > 0) {
              console.log(JSON.stringify({ level: "info", msg: "engagement sweep", ...summary }));
            }
          });
        }

        if (due.sla) {
          await guard("SLA sweep", async () => {
            const summary = await runSlaSweep({
              telegram,
              store,
              moderatorChatId: config.moderatorChatId,
              policy: config.sla,
              conversationIdleMinutes: config.conversationIdleMinutes,
              followupMinutes: config.followupMinutes,
            });
            // Only worth a log line when the sweep did something; an idle
            // queue sweeping every five minutes would drown the logs.
            if (summary.nudged > 0 || summary.warned > 0 || summary.conversationsClosed > 0) {
              console.log(JSON.stringify({ level: "info", msg: "SLA sweep", ...summary }));
            }
          });
        }

        if (due.archive) {
          await guard("weekly archive", async () => {
            const archived = await store.archiveClosedConversations(
              config.archiveAfterDays,
              config.archiveBatchSize,
            );
            // Purged in the same run as the archive, so the two halves of the
            // retention policy cannot drift apart in scheduling.
            const purged = await store.purgeHistory(
              config.historyRetentionYears,
              config.archiveBatchSize,
            );
            // Always logged, including a run that moved nothing: this happens
            // weekly, so "it did nothing" and "it never ran" need telling
            // apart, and there is no next run for days.
            console.log(
              JSON.stringify({
                level: "info",
                msg: "weekly archive",
                olderThanDays: config.archiveAfterDays,
                retentionYears: config.historyRetentionYears,
                archived,
                purged,
              }),
            );
          });
        }
      })(),
    );
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
      const chatId = update.callback_query.message?.chat.id;

      // Which keyboard was tapped is decided by which chat it was in, and the
      // two are handled by different code with different parsers. The
      // moderator group's cards carry ticket actions; a customer's private
      // chat carries the follow-up and the survey. Routing on the chat means a
      // customer payload can never reach the moderator handler.
      if (chatId === config.moderatorChatId) {
        const moderatorCtx: ModeratorContext = {
          telegram,
          store,
          moderatorChatId: config.moderatorChatId,
        };
        await handleCallback(moderatorCtx, update.callback_query);
        return;
      }

      // A private chat is a customer. The handler re-checks that the
      // conversation in the payload really belongs to this chat, because
      // unlike a moderator card the id travels in callback data the client
      // could edit.
      if (update.callback_query.message?.chat.type === "private") {
        await handleCustomerCallback({ telegram, store }, update.callback_query);
      }
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
      onTicket: selectOnTicket(config, telegram, store),
      moderatorChatId: config.moderatorChatId,
      rateLimitPerMinute: config.rateLimitPerMinute,
      conversationIdleMinutes: config.conversationIdleMinutes,
      followupMinutes: config.followupMinutes,
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
