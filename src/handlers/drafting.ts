/**
 * Drafting a ticket and refreshing its moderator card.
 *
 * Extracted from the customer handler because two different runtimes do this
 * now: the Worker, inline on the webhook, and a GitHub Actions job woken by
 * `repository_dispatch`. They must produce an identical card -- same text,
 * same buttons, same audit events -- so they run the same function rather
 * than two implementations that drift.
 *
 * Nothing here is Cloudflare-specific. The adapters it uses work equally in
 * a Worker and in Node, which is what makes the second runtime possible at
 * all.
 */

import type { DraftResult } from "../adapters/claude.js";
import type { TelegramClient } from "../adapters/telegram.js";
import type { Store } from "../adapters/store.js";
import type { DraftRequest } from "../core/draft.js";
import type { KnowledgeBase } from "../core/knowledge.js";
import { renderCard, renderKeyboard } from "../core/moderator-card.js";
import type { Ticket } from "../core/tickets.js";

export interface DraftingContext {
  telegram: TelegramClient;
  store: Store;
  knowledge: KnowledgeBase;
  moderatorChatId: number;
  /** Writes the suggested answer, or null for moderator-only. */
  draft: ((request: DraftRequest) => Promise<DraftResult>) | null;
}

/**
 * Ask the configured provider for a draft, store it, and refresh the card
 * with the result and its buttons.
 *
 * With no provider configured the request is skipped rather than attempted:
 * the ticket, the card and the moderator's Edit button all work, so the
 * answer is simply written by a person. That is a deliberate operating mode,
 * not a degraded one -- the review was always the thing standing between a
 * draft and a customer.
 */
export async function draftAndUpdateCard(
  ctx: DraftingContext,
  ticket: Ticket,
): Promise<void> {
  const result: DraftResult = ctx.draft
    ? await ctx.draft({
        question: ticket.question,
        questionLanguage: ticket.questionLanguage,
        knowledge: ctx.knowledge,
      })
    : {
        ok: false,
        error:
          "No drafting provider is configured, so there is no suggested " +
          "answer. Tap Edit and write the reply.",
      };

  const updated = result.ok
    ? await ctx.store.setDraft(ticket.id, result.text, null)
    : await ctx.store.setDraft(ticket.id, null, result.error);

  await ctx.store.recordEvent({
    ticketId: ticket.id,
    event: result.ok ? "draft_created" : ctx.draft ? "draft_failed" : "draft_skipped",
    detail: result.ok ? result.text : result.error,
  });

  if (result.ok) {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "draft created",
        ticketId: ticket.id,
        knowledgeVersion: ctx.knowledge.version,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
      }),
    );
  } else if (ctx.draft) {
    // A failed draft is not a failed request: the card still carries the
    // question and its buttons, so the run stays green and a moderator
    // answers by hand. But green and silent are different things -- without
    // this line the only copy of the reason is the card itself, which is the
    // one place an operator reading logs is not looking.
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "draft failed",
        ticketId: ticket.id,
        knowledgeVersion: ctx.knowledge.version,
        reason: result.error,
      }),
    );
  }

  // A ticket whose card never posted has nothing to refresh. The draft is
  // stored either way, so a moderator can still find it.
  if (!updated || updated.cardMessageId === null) return;

  await ctx.telegram.editMessageText({
    chatId: ctx.moderatorChatId,
    messageId: updated.cardMessageId,
    text: renderCard(updated),
    parseMode: "HTML",
    replyMarkup: renderKeyboard(updated),
  });
}
