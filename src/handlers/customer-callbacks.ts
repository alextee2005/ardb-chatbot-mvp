/**
 * Taps on the buttons the bot sends to a customer.
 *
 * Three of them: "yes I have another question", "no thanks", and a
 * satisfaction score. All three are scoped to a conversation.
 *
 * Authorization is the chat, as it is for moderator taps, but the check here
 * has to be stricter. A moderator card lives in one private group, so being
 * able to see it is proof enough. A customer's buttons live in their own
 * private chat, and the conversation id travels in the callback data where the
 * client could change it -- so every handler below confirms the conversation
 * actually belongs to the chat the tap came from. Without that, tapping a
 * hand-edited payload would let one customer end another's conversation or
 * file a satisfaction score against it.
 */

import type { Store } from "../adapters/store.js";
import type { TelegramClient } from "../adapters/telegram.js";
import { parseCustomerCallback } from "../core/callbacks.js";
import { isSurveyScore } from "../core/conversations.js";
import { CUSTOMER_MESSAGES } from "../core/messages.js";
import { stripButtons } from "./engagement.js";
import type { CallbackQuery } from "./moderator.js";

export interface CustomerCallbackContext {
  telegram: TelegramClient;
  store: Store;
}

export async function handleCustomerCallback(
  ctx: CustomerCallbackContext,
  query: CallbackQuery,
): Promise<void> {
  const parsed = parseCustomerCallback(query.data);
  const chatId = query.message?.chat.id;

  // Always answer, even when the payload is unusable: an unanswered callback
  // leaves a spinner on the customer's button for a minute.
  if (!parsed || chatId === undefined) {
    await ctx.telegram.answerCallbackQuery({ callbackQueryId: query.id });
    return;
  }

  const conversation = await ctx.store.getConversation(parsed.conversationId);

  // The authorization check. A conversation belonging to a different chat is
  // treated exactly like one that does not exist -- no acknowledgement that
  // the id was real, because confirming that would itself leak.
  if (!conversation || conversation.customerChatId !== chatId) {
    await ctx.telegram.answerCallbackQuery({ callbackQueryId: query.id });
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "customer callback for a conversation not in this chat",
        conversationId: parsed.conversationId,
        chatId,
      }),
    );
    return;
  }

  switch (parsed.action) {
    case "more":
      await handleMore(ctx, query, conversation.id, chatId);
      return;
    case "done":
      await handleDone(ctx, query, conversation.id, chatId);
      return;
    case "rate":
      await handleRate(ctx, query, conversation, chatId, parsed.score);
      return;
  }
}

/** Yes: keep the conversation open and invite the next question. */
async function handleMore(
  ctx: CustomerCallbackContext,
  query: CallbackQuery,
  conversationId: number,
  chatId: number,
): Promise<void> {
  const reopened = await ctx.store.reopenForMoreQuestions(conversationId);

  await ctx.telegram.answerCallbackQuery({ callbackQueryId: query.id });

  if (!reopened) {
    // Already closed -- the idle sweep got there between the question being
    // asked and the button being tapped. The customer can simply write again,
    // which starts a fresh conversation, so say that rather than nothing.
    await ctx.telegram.sendMessage({ chatId, text: CUSTOMER_MESSAGES.staleButton });
    return;
  }

  if (query.message) {
    await stripButtons(ctx.telegram, chatId, query.message.message_id, CUSTOMER_MESSAGES.followUp);
  }
  await ctx.telegram.sendMessage({ chatId, text: CUSTOMER_MESSAGES.followUpYes });
}

/**
 * No: end the interaction.
 *
 * The survey is not sent from here. Closing the conversation is what makes it
 * due one, and the sweep that runs every minute picks it up -- so there is one
 * path to a survey rather than two, and an interaction that ends by timing out
 * is surveyed by exactly the same code as one the customer ended themselves.
 */
async function handleDone(
  ctx: CustomerCallbackContext,
  query: CallbackQuery,
  conversationId: number,
  chatId: number,
): Promise<void> {
  const closed = await ctx.store.closeConversationById(conversationId, "completed");

  await ctx.telegram.answerCallbackQuery({ callbackQueryId: query.id });

  if (query.message) {
    await stripButtons(ctx.telegram, chatId, query.message.message_id, CUSTOMER_MESSAGES.followUp);
  }

  if (closed) {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "conversation closed",
        conversationId,
        reason: "completed",
        questionCount: closed.questionCount,
      }),
    );
  }

  await ctx.telegram.sendMessage({ chatId, text: CUSTOMER_MESSAGES.followUpNo });
}

/** A satisfaction score. */
async function handleRate(
  ctx: CustomerCallbackContext,
  query: CallbackQuery,
  conversation: { id: number; customerChatId: number },
  chatId: number,
  score: number,
): Promise<void> {
  // The parser already bounds this to 1-5; this is the same rule stated where
  // the value is used, so a future change to the keyboard cannot write a score
  // the database would reject at 3am.
  if (!isSurveyScore(score)) {
    await ctx.telegram.answerCallbackQuery({ callbackQueryId: query.id });
    return;
  }

  const stored = await ctx.store.recordSurveyResponse({
    conversationId: conversation.id,
    customerChatId: chatId,
    customerUserId: query.from.id,
    score,
  });

  await ctx.telegram.answerCallbackQuery({ callbackQueryId: query.id });

  // The buttons go whether or not this was the first tap, so a second tap is
  // not invited. A repeat is not an error worth telling the customer about:
  // they expressed one opinion and it was recorded.
  if (query.message) {
    await stripButtons(ctx.telegram, chatId, query.message.message_id, CUSTOMER_MESSAGES.survey);
  }

  if (stored) {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "survey response recorded",
        conversationId: conversation.id,
        score,
      }),
    );
    await ctx.telegram.sendMessage({ chatId, text: CUSTOMER_MESSAGES.surveyThanks });
  }
}
