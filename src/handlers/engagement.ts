/**
 * Ending an interaction, and asking how it went.
 *
 * Two pieces of the same flow:
 *
 *   answer delivered → (3 min) → "is there anything else?" → Yes → keep going
 *                                                          → No  → close
 *   conversation closed (either way, or by going idle) → satisfaction survey
 *
 * Both are driven by a cron sweep rather than a timer, because a Worker does
 * not outlive its request. Each step claims its work in SQL before sending
 * anything, so two overlapping sweeps cannot ask the same customer twice.
 *
 * Nothing here is Cloudflare-specific, and the decision rules live in
 * core/conversations.ts, so the rules are testable without a database or a
 * Telegram client.
 */

import type { Store } from "../adapters/store.js";
import type { TelegramClient } from "../adapters/telegram.js";
import type { InlineKeyboard } from "../core/moderator-card.js";
import { encodeCustomerCallback } from "../core/callbacks.js";
import { SURVEY_SCORES, type Conversation } from "../core/conversations.js";
import { CUSTOMER_MESSAGES } from "../core/messages.js";

export interface EngagementContext {
  telegram: TelegramClient;
  store: Store;
  followupMinutes: number;
  /** Idle minutes after which an unanswered conversation is closed. */
  idleMinutes: number;
}

/** Bounds one sweep, so a backlog cannot blow the CPU limit. */
const MAX_PER_SWEEP = 50;

export interface EngagementSummary {
  followupsAsked: number;
  surveysSent: number;
}

/** Yes / No, side by side -- one row, so neither reads as the default. */
export function followupKeyboard(conversationId: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        {
          text: CUSTOMER_MESSAGES.followUpYesButton,
          callback_data: encodeCustomerCallback("more", conversationId),
        },
        {
          text: CUSTOMER_MESSAGES.followUpNoButton,
          callback_data: encodeCustomerCallback("done", conversationId),
        },
      ],
    ],
  };
}

/**
 * The 1-5 scale, as a single row of five buttons.
 *
 * One row rather than five, so the scale reads left to right as a scale. The
 * numbers carry no words: the message says what 1 and 5 mean, and a label on
 * each button would not survive being bilingual in 64 bytes of callback data
 * and a phone-width screen.
 */
export function surveyKeyboard(conversationId: number): InlineKeyboard {
  return {
    inline_keyboard: [
      SURVEY_SCORES.map((score) => ({
        text: String(score),
        callback_data: encodeCustomerCallback("rate", conversationId, score),
      })),
    ],
  };
}

/**
 * Ask the customers who are due it whether they need anything else.
 *
 * Claim first, then send. A claim followed by a failed send costs the customer
 * nothing visible -- the conversation simply times out as it would have
 * before this feature existed -- whereas sending first and failing to record
 * it would ask the same person twice.
 */
async function askFollowups(ctx: EngagementContext): Promise<number> {
  const due = await ctx.store.findConversationsDueFollowup(
    ctx.followupMinutes,
    MAX_PER_SWEEP,
  );

  let asked = 0;
  for (const conversation of due) {
    if (!(await ctx.store.claimFollowup(conversation.id))) continue;

    const sent = await ctx.telegram.sendMessage({
      chatId: conversation.customerChatId,
      text: CUSTOMER_MESSAGES.followUp,
      replyMarkup: followupKeyboard(conversation.id),
    });

    if (sent.ok && sent.result) {
      await ctx.store.setFollowupMessageId(conversation.id, sent.result.message_id);
      asked += 1;
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "failed to send follow-up",
          conversationId: conversation.id,
          description: sent.description,
        }),
      );
    }
  }
  return asked;
}

/** Survey every interaction that has ended and not yet been asked. */
async function sendSurveys(ctx: EngagementContext): Promise<number> {
  const due = await ctx.store.findConversationsDueSurvey(MAX_PER_SWEEP);

  let sent = 0;
  for (const conversation of due) {
    if (!(await ctx.store.claimSurvey(conversation.id))) continue;

    const message = await ctx.telegram.sendMessage({
      chatId: conversation.customerChatId,
      text: CUSTOMER_MESSAGES.survey,
      replyMarkup: surveyKeyboard(conversation.id),
    });

    if (message.ok && message.result) {
      await ctx.store.setSurveyMessageId(conversation.id, message.result.message_id);
      sent += 1;
    } else {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "failed to send survey",
          conversationId: conversation.id,
          description: message.description,
        }),
      );
    }
  }
  return sent;
}

/**
 * One pass of the engagement sweep.
 *
 * Order matters: conversations that have just gone idle are closed first, so
 * their surveys go out in this same pass rather than waiting for the next one.
 */
export async function runEngagementSweep(
  ctx: EngagementContext,
): Promise<EngagementSummary> {
  // Closing idle conversations here as well as in the SLA sweep is deliberate.
  // This sweep runs every minute and the SLA sweep every five, and a customer
  // who has gone quiet should get their survey promptly rather than up to five
  // minutes late. Both paths claim in SQL, so running both is harmless.
  const closed = await ctx.store.closeIdleConversations(ctx.idleMinutes, MAX_PER_SWEEP);
  if (closed.length > 0) {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "conversations closed as idle",
        count: closed.length,
      }),
    );
  }

  return {
    followupsAsked: await askFollowups(ctx),
    surveysSent: await sendSurveys(ctx),
  };
}

/**
 * Strip the buttons from a message once one of them has been tapped.
 *
 * Telegram has no "remove keyboard" call for an inline keyboard; editing the
 * text with no markup is how it is done. Failure is ignored on purpose: the
 * tap has already been handled, and a stale button is caught by the status
 * checks in the handler anyway.
 */
export async function stripButtons(
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  await telegram.editMessageText({ chatId, messageId, text });
}

export type { Conversation };
