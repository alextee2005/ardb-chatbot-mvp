/**
 * The customer side: /start, and questions arriving in a private chat.
 */

import { draftResponse, type ClaudeConfig } from "../adapters/claude.js";
import { displayName, type TelegramClient, type TelegramMessage } from "../adapters/telegram.js";
import type { Store } from "../adapters/store.js";
import { detectLanguage } from "../core/language.js";
import { CUSTOMER_MESSAGES } from "../core/messages.js";
import { renderCard, renderKeyboard } from "../core/moderator-card.js";
import type { KnowledgeBase } from "../core/knowledge.js";
import type { Ticket } from "../core/tickets.js";

export interface CustomerContext {
  telegram: TelegramClient;
  store: Store;
  knowledge: KnowledgeBase;
  claude: ClaudeConfig;
  moderatorChatId: number;
  rateLimitPerMinute: number;
}

export async function handleStart(
  ctx: CustomerContext,
  message: TelegramMessage,
): Promise<void> {
  await ctx.telegram.sendMessage({
    chatId: message.chat.id,
    text: CUSTOMER_MESSAGES.greeting,
  });
}

export async function handleQuestion(
  ctx: CustomerContext,
  message: TelegramMessage,
): Promise<void> {
  const question = message.text?.trim();
  const from = message.from;

  // Neither should be possible for a text message in a private chat, but the
  // Bot API marks both optional and a missing `from` would break attribution.
  if (!question || !from) {
    await ctx.telegram.sendMessage({
      chatId: message.chat.id,
      text: CUSTOMER_MESSAGES.unsupportedMessage,
    });
    return;
  }

  const recent = await ctx.store.countRecentQuestions(from.id);
  if (recent >= ctx.rateLimitPerMinute) {
    await ctx.telegram.sendMessage({
      chatId: message.chat.id,
      text: CUSTOMER_MESSAGES.rateLimited,
    });
    return;
  }

  // Checked before the new ticket exists, so it reflects genuinely earlier
  // questions rather than this one.
  const hadOpenTicket = await ctx.store.hasOpenTicket(from.id);

  const ticket = await ctx.store.createTicket({
    customerChatId: message.chat.id,
    customerUserId: from.id,
    customerName: displayName(from),
    customerUsername: from.username ?? null,
    question,
    questionLanguage: detectLanguage(question),
    knowledgeVersion: ctx.knowledge.version,
  });

  await ctx.store.recordEvent({
    ticketId: ticket.id,
    event: "question_received",
    actorId: from.id,
    actorName: displayName(from),
  });

  await ctx.telegram.sendMessage({
    chatId: message.chat.id,
    text: hadOpenTicket
      ? CUSTOMER_MESSAGES.alreadyPending
      : CUSTOMER_MESSAGES.acknowledgement,
  });

  // Post the card before drafting, so the moderators can see a customer is
  // waiting even if the Claude call is slow or fails outright.
  const card = await ctx.telegram.sendMessage({
    chatId: ctx.moderatorChatId,
    text: renderCard(ticket),
    parseMode: "HTML",
  });

  if (card.ok && card.result) {
    await ctx.store.setCardMessageId(ticket.id, card.result.message_id);
    ticket.cardMessageId = card.result.message_id;
  } else {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "failed to post moderator card",
        ticketId: ticket.id,
        description: card.description,
      }),
    );
  }

  await draftAndUpdateCard(ctx, ticket);
}

/**
 * Ask Claude for a draft, store it, and refresh the card with the result and
 * its buttons.
 */
async function draftAndUpdateCard(ctx: CustomerContext, ticket: Ticket): Promise<void> {
  const result = await draftResponse(ctx.claude, {
    question: ticket.question,
    questionLanguage: ticket.questionLanguage,
    knowledge: ctx.knowledge,
  });

  const updated = result.ok
    ? await ctx.store.setDraft(ticket.id, result.text, null)
    : await ctx.store.setDraft(ticket.id, null, result.error);

  await ctx.store.recordEvent({
    ticketId: ticket.id,
    event: result.ok ? "draft_created" : "draft_failed",
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
  }

  if (!updated || updated.cardMessageId === null) return;

  await ctx.telegram.editMessageText({
    chatId: ctx.moderatorChatId,
    messageId: updated.cardMessageId,
    text: renderCard(updated),
    parseMode: "HTML",
    replyMarkup: renderKeyboard(updated),
  });
}
