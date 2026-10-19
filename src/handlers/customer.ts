/**
 * The customer side: /start, and questions arriving in a private chat.
 */

import { displayName, type TelegramClient, type TelegramMessage } from "../adapters/telegram.js";
import type { Store } from "../adapters/store.js";
import { isIdle, MAX_HISTORY_TURNS } from "../core/conversations.js";
import { detectLanguage } from "../core/language.js";
import { CUSTOMER_MESSAGES } from "../core/messages.js";
import { renderCard } from "../core/moderator-card.js";
import type { KnowledgeBase } from "../core/knowledge.js";
import type { Ticket } from "../core/tickets.js";

export interface CustomerContext {
  telegram: TelegramClient;
  store: Store;
  knowledge: KnowledgeBase;
  /**
   * What happens once the ticket and its card exist.
   *
   * Either drafting inline and refreshing the card, or handing the ticket to
   * another runtime that will do both. The flow does not care which: it has
   * already told the customer to wait and already shown the moderator the
   * question, so a draft arriving in two seconds or two minutes changes
   * nothing here. Null means moderator-only.
   */
  onTicket: ((ticket: Ticket) => Promise<void>) | null;
  moderatorChatId: number;
  rateLimitPerMinute: number;
  /**
   * How long a conversation may sit idle before the next question is treated
   * as the start of a new interaction rather than a follow-up.
   */
  conversationIdleMinutes: number;
}

export async function handleStart(
  ctx: CustomerContext,
  message: TelegramMessage,
): Promise<void> {
  // /start is the customer saying "let's begin", so whatever came before is
  // over. Closing it here is what gives an interaction an end rather than
  // leaving it open until the idle sweep notices -- and it stops the next
  // question being drafted as a follow-up to a thread the customer has
  // visibly moved on from.
  const closed = await ctx.store.closeConversation(message.chat.id, "restarted");
  if (closed) {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "conversation closed",
        conversationId: closed.id,
        reason: "restarted",
        questionCount: closed.questionCount,
      }),
    );
  }

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

  // A conversation the customer abandoned hours ago is not the thread this
  // question belongs to. Closed here, on arrival, rather than waiting for the
  // sweep: the sweep makes the record timely, but this is what makes the
  // threading correct, and a question must never be drafted as a follow-up to
  // a conversation that had already ended.
  const existing = await ctx.store.getOpenConversation(message.chat.id);
  if (existing && isIdle(existing, ctx.conversationIdleMinutes, new Date())) {
    await ctx.store.closeConversation(message.chat.id, "idle");
  }

  const conversation = await ctx.store.openConversation({
    customerChatId: message.chat.id,
    customerUserId: from.id,
  });

  const ticket = await ctx.store.createTicket({
    conversationId: conversation.id,
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
    // Which interaction this question belongs to, and where in it. Recorded on
    // the event too, so the audit trail stands on its own even if the
    // conversation row is later purged under a retention policy.
    detail: `conversation ${conversation.id}, question ${conversation.questionCount}`,
  });

  await ctx.telegram.sendMessage({
    chatId: message.chat.id,
    text: hadOpenTicket
      ? CUSTOMER_MESSAGES.alreadyPending
      : CUSTOMER_MESSAGES.acknowledgement,
  });

  // Earlier turns, for the card. Fetched before posting rather than left to
  // the drafting step so a moderator can answer a follow-up straight away --
  // the card is posted before drafting precisely so it is useful when drafting
  // is slow or fails, and without the thread a follow-up is unanswerable.
  const turns =
    conversation.questionCount > 1
      ? await ctx.store.getConversationHistory(conversation.id, ticket.id, MAX_HISTORY_TURNS)
      : [];

  const card = await ctx.telegram.sendMessage({
    chatId: ctx.moderatorChatId,
    text: renderCard(ticket, { turns }),
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

  if (ctx.onTicket) await ctx.onTicket(ticket);
}
