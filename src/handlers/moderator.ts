/**
 * The moderator side: button taps in the moderator group, and the typed
 * replies that carry an edited answer.
 *
 * Authorization is positional. These handlers are only reached for updates
 * originating in the configured moderator group (the Worker checks that), so
 * anyone who can see a card is a moderator by construction. There is no
 * separate allowlist to drift out of sync with the group's membership.
 */

import type { Store } from "../adapters/store.js";
import {
  displayName,
  type TelegramClient,
  type TelegramMessage,
} from "../adapters/telegram.js";
import { parseCallback } from "../core/callbacks.js";
import { CUSTOMER_MESSAGES, MODERATOR_MESSAGES } from "../core/messages.js";
import { renderCard, renderKeyboard } from "../core/moderator-card.js";
import { canModeratorAct, hasSendableDraft, ticketRef, type Ticket } from "../core/tickets.js";

export interface ModeratorContext {
  telegram: TelegramClient;
  store: Store;
  moderatorChatId: number;
}

export interface CallbackQuery {
  id: string;
  data?: string;
  from: { id: number; first_name: string; last_name?: string; username?: string };
  message?: { message_id: number; chat: { id: number } };
}

export async function handleCallback(
  ctx: ModeratorContext,
  query: CallbackQuery,
): Promise<void> {
  const parsed = parseCallback(query.data);
  if (!parsed) {
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: "Unrecognised button.",
    });
    return;
  }

  const moderatorId = query.from.id;
  const moderatorName = displayName(query.from);
  const ticket = await ctx.store.getTicket(parsed.ticketId);
  const permitted = canModeratorAct(ticket, moderatorId);

  if (!permitted.ok) {
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text:
        permitted.reason === "not_found"
          ? MODERATOR_MESSAGES.notFound
          : permitted.reason === "resolved"
            ? MODERATOR_MESSAGES.alreadyResolved
            : MODERATOR_MESSAGES.claimedByOther,
      showAlert: true,
    });
    return;
  }

  // Non-null once `permitted.ok` holds.
  const current = ticket as Ticket;

  switch (parsed.action) {
    case "send":
      await sendAsDrafted(ctx, query, current, moderatorId, moderatorName);
      return;
    case "edit":
      await promptForEdit(ctx, query, current, moderatorId, moderatorName);
      return;
    case "reject":
      await reject(ctx, query, current, moderatorId, moderatorName);
      return;
  }
}

async function sendAsDrafted(
  ctx: ModeratorContext,
  query: CallbackQuery,
  ticket: Ticket,
  moderatorId: number,
  moderatorName: string,
): Promise<void> {
  if (!hasSendableDraft(ticket)) {
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: MODERATOR_MESSAGES.draftFailed,
      showAlert: true,
    });
    return;
  }

  await deliver(ctx, query, ticket, ticket.draft as string, moderatorId, moderatorName);
}

/**
 * Ask for the replacement text with a force-reply.
 *
 * The force-reply is what makes the edit unambiguous: the moderator's answer
 * arrives as a Telegram reply whose `reply_to_message.message_id` identifies
 * the ticket exactly. Guessing from "the next message they type" would pick up
 * ordinary group chatter.
 */
async function promptForEdit(
  ctx: ModeratorContext,
  query: CallbackQuery,
  ticket: Ticket,
  moderatorId: number,
  moderatorName: string,
): Promise<void> {
  const claimed = await ctx.store.claimTicket(ticket.id, moderatorId, moderatorName);
  if (!claimed) {
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: MODERATOR_MESSAGES.claimedByOther,
      showAlert: true,
    });
    return;
  }

  const prompt = await ctx.telegram.sendMessage({
    chatId: ctx.moderatorChatId,
    text: MODERATOR_MESSAGES.editPrompt(ticketRef(claimed)),
    replyMarkup: { force_reply: true, selective: true },
    replyToMessageId: claimed.cardMessageId ?? undefined,
  });

  if (prompt.ok && prompt.result) {
    await ctx.store.setPromptMessageId(claimed.id, prompt.result.message_id);
  }

  await ctx.store.recordEvent({
    ticketId: claimed.id,
    event: "edit_started",
    actorId: moderatorId,
    actorName: moderatorName,
  });

  await ctx.telegram.answerCallbackQuery({ callbackQueryId: query.id });
  await refreshCard(ctx, claimed);
}

async function reject(
  ctx: ModeratorContext,
  query: CallbackQuery,
  ticket: Ticket,
  moderatorId: number,
  moderatorName: string,
): Promise<void> {
  const resolved = await ctx.store.resolveTicket(
    ticket.id,
    "rejected",
    null,
    moderatorId,
    moderatorName,
  );

  if (!resolved) {
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: MODERATOR_MESSAGES.alreadyResolved,
      showAlert: true,
    });
    return;
  }

  await ctx.telegram.sendMessage({
    chatId: resolved.customerChatId,
    text: CUSTOMER_MESSAGES.rejected,
  });

  await ctx.store.recordEvent({
    ticketId: resolved.id,
    event: "rejected",
    actorId: moderatorId,
    actorName: moderatorName,
  });

  await ctx.telegram.answerCallbackQuery({
    callbackQueryId: query.id,
    text: MODERATOR_MESSAGES.rejected(ticketRef(resolved)),
  });
  await refreshCard(ctx, resolved);
}

/**
 * A typed message in the moderator group. Only a reply to a card or to an edit
 * prompt means anything; everything else is ordinary group conversation and is
 * ignored.
 */
export async function handleModeratorMessage(
  ctx: ModeratorContext,
  message: TelegramMessage,
): Promise<void> {
  const replyTo = message.reply_to_message?.message_id;
  const text = message.text?.trim();
  if (!replyTo || !text || !message.from) return;

  const ticket = await ctx.store.getTicketByReplyTarget(replyTo);
  if (!ticket) return;

  const moderatorId = message.from.id;
  const moderatorName = displayName(message.from);
  const permitted = canModeratorAct(ticket, moderatorId);

  if (!permitted.ok) {
    await ctx.telegram.sendMessage({
      chatId: ctx.moderatorChatId,
      text:
        permitted.reason === "resolved"
          ? MODERATOR_MESSAGES.alreadyResolved
          : MODERATOR_MESSAGES.claimedByOther,
      replyToMessageId: message.message_id,
    });
    return;
  }

  // A moderator may reply straight to a card without tapping Edit first, so
  // claim here too rather than assuming promptForEdit already ran.
  const claimed = await ctx.store.claimTicket(ticket.id, moderatorId, moderatorName);
  if (!claimed) {
    await ctx.telegram.sendMessage({
      chatId: ctx.moderatorChatId,
      text: MODERATOR_MESSAGES.claimedByOther,
      replyToMessageId: message.message_id,
    });
    return;
  }

  await deliver(ctx, null, claimed, text, moderatorId, moderatorName, message.message_id);
}

/**
 * Send the final answer to the customer and close the ticket.
 *
 * The ticket is resolved *before* the customer message goes out: the resolve
 * is conditional on the ticket not already being terminal, so it is what stops
 * two moderators delivering two answers. Sending first and recording after
 * would leave that race open.
 */
async function deliver(
  ctx: ModeratorContext,
  query: CallbackQuery | null,
  ticket: Ticket,
  answer: string,
  moderatorId: number,
  moderatorName: string,
  replyToMessageId?: number,
): Promise<void> {
  const resolved = await ctx.store.resolveTicket(
    ticket.id,
    "sent",
    answer,
    moderatorId,
    moderatorName,
  );

  if (!resolved) {
    const notice = MODERATOR_MESSAGES.alreadyResolved;
    if (query) {
      await ctx.telegram.answerCallbackQuery({
        callbackQueryId: query.id,
        text: notice,
        showAlert: true,
      });
    } else {
      await ctx.telegram.sendMessage({
        chatId: ctx.moderatorChatId,
        text: notice,
        replyToMessageId,
      });
    }
    return;
  }

  const delivery = await ctx.telegram.sendMessage({
    chatId: resolved.customerChatId,
    text: answer,
  });

  await ctx.store.recordEvent({
    ticketId: resolved.id,
    event: delivery.ok ? "answer_sent" : "answer_delivery_failed",
    actorId: moderatorId,
    actorName: moderatorName,
    detail: delivery.ok ? answer : (delivery.description ?? "unknown delivery failure"),
  });

  const notice = delivery.ok
    ? MODERATOR_MESSAGES.sent(ticketRef(resolved))
    : `Could not deliver ${ticketRef(resolved)} to the customer: ${delivery.description ?? "unknown error"}`;

  if (query) {
    await ctx.telegram.answerCallbackQuery({
      callbackQueryId: query.id,
      text: notice,
      showAlert: !delivery.ok,
    });
  } else {
    await ctx.telegram.sendMessage({
      chatId: ctx.moderatorChatId,
      text: notice,
      replyToMessageId,
    });
  }

  await refreshCard(ctx, resolved);
}

/** Rewrite the card in place so the group always shows current state. */
async function refreshCard(ctx: ModeratorContext, ticket: Ticket): Promise<void> {
  if (ticket.cardMessageId === null) return;
  await ctx.telegram.editMessageText({
    chatId: ctx.moderatorChatId,
    messageId: ticket.cardMessageId,
    text: renderCard(ticket),
    parseMode: "HTML",
    replyMarkup: renderKeyboard(ticket),
  });
}
