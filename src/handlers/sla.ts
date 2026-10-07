/**
 * The scheduled sweep over unanswered tickets.
 *
 * Runs on a Cron Trigger. Candidates come from the database by age; what to do
 * with each one is decided by `decideSlaActions`, and the database refuses a
 * duplicate nudge or warning, so two overlapping sweeps cannot double-send.
 */

import type { Store } from "../adapters/store.js";
import type { TelegramClient } from "../adapters/telegram.js";
import { CUSTOMER_MESSAGES, MODERATOR_MESSAGES } from "../core/messages.js";
import {
  decideSlaActions,
  formatWaiting,
  type SlaPolicy,
} from "../core/sla.js";
import { ticketRef } from "../core/tickets.js";

export interface SlaContext {
  telegram: TelegramClient;
  store: Store;
  moderatorChatId: number;
  policy: SlaPolicy;
}

/** Bounds one sweep's work, so a backlog cannot blow the CPU limit. */
const MAX_TICKETS_PER_SWEEP = 50;

export interface SweepSummary {
  examined: number;
  nudged: number;
  warned: number;
}

export async function runSlaSweep(
  ctx: SlaContext,
  now: Date = new Date(),
): Promise<SweepSummary> {
  // The earlier of the two thresholds decides who is even a candidate.
  const earliestThreshold = Math.min(
    ctx.policy.nudgeAfterMinutes,
    ctx.policy.warnCustomerAfterMinutes,
  );

  const candidates = await ctx.store.findOpenTickets(
    earliestThreshold,
    MAX_TICKETS_PER_SWEEP,
  );

  const summary: SweepSummary = { examined: candidates.length, nudged: 0, warned: 0 };

  for (const ticket of candidates) {
    const actions = decideSlaActions(ticket, now, ctx.policy);
    const waiting = formatWaiting(ticket, now);

    if (actions.includes("nudge_moderators")) {
      // Claim the nudge first. If another sweep got there, skip the message
      // rather than sending a duplicate.
      if (await ctx.store.markNudged(ticket.id, ctx.policy.nudgeRepeatMinutes)) {
        await ctx.telegram.sendMessage({
          chatId: ctx.moderatorChatId,
          text: MODERATOR_MESSAGES.nudge(
            ticketRef(ticket),
            waiting,
            ticket.nudgeCount + 1,
            ctx.policy.maxNudges,
          ),
          // Threads the reminder under the card, so tapping it scrolls to the
          // question rather than making the moderator hunt for it.
          replyToMessageId: ticket.cardMessageId ?? undefined,
        });
        await ctx.store.recordEvent({
          ticketId: ticket.id,
          event: "moderators_nudged",
          detail: `waiting ${waiting}`,
        });
        summary.nudged += 1;
      }
    }

    if (actions.includes("warn_customer")) {
      if (await ctx.store.markCustomerWarned(ticket.id)) {
        await ctx.telegram.sendMessage({
          chatId: ticket.customerChatId,
          text: CUSTOMER_MESSAGES.stillWaiting,
        });
        await ctx.telegram.sendMessage({
          chatId: ctx.moderatorChatId,
          text: MODERATOR_MESSAGES.customerWarned(ticketRef(ticket), waiting),
          replyToMessageId: ticket.cardMessageId ?? undefined,
        });
        await ctx.store.recordEvent({
          ticketId: ticket.id,
          event: "customer_warned",
          detail: `waiting ${waiting}`,
        });
        summary.warned += 1;
      }
    }
  }

  return summary;
}
