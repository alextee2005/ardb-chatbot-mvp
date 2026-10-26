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
import { refreshCard } from "./card.js";
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
  /** The two windows of the ending sequence; see `isConversationOver`. */
  conversationIdleMinutes: number;
  followupMinutes: number;
}

/** Bounds one sweep's work, so a backlog cannot blow the CPU limit. */
const MAX_TICKETS_PER_SWEEP = 50;

/** Same bound for conversations; a quiet night cannot queue unbounded work. */
const MAX_CONVERSATIONS_PER_SWEEP = 100;

export interface SweepSummary {
  examined: number;
  nudged: number;
  warned: number;
  /** Drafts given up on, so the card became answerable by hand. */
  draftsTimedOut: number;
  /** Interactions recorded as ended because the customer went quiet. */
  conversationsClosed: number;
}

export async function runSlaSweep(
  ctx: SlaContext,
  now: Date = new Date(),
): Promise<SweepSummary> {
  // The earliest of the thresholds decides who is even a candidate, and the
  // draft timeout has to be in here: it is the shortest of the three on the
  // default policy (5 minutes against 10 and 45), so leaving it out would
  // keep a stuck ticket out of the candidate list until the nudge threshold
  // and quietly make the timeout fire at 10 minutes rather than 5. A test
  // asserts this covers the whole policy.
  const earliestThreshold = Math.min(
    ctx.policy.nudgeAfterMinutes,
    ctx.policy.warnCustomerAfterMinutes,
    ctx.policy.draftTimeoutMinutes,
  );

  const candidates = await ctx.store.findOpenTickets(
    earliestThreshold,
    MAX_TICKETS_PER_SWEEP,
  );

  const summary: SweepSummary = {
    examined: candidates.length,
    nudged: 0,
    warned: 0,
    draftsTimedOut: 0,
    conversationsClosed: 0,
  };

  for (const ticket of candidates) {
    const actions = decideSlaActions(ticket, now, ctx.policy);
    const waiting = formatWaiting(ticket, now);

    // Before the nudge, deliberately: this is what puts Edit and Reject on
    // the card, so a nudge decided in the same pass points at a card a
    // moderator can act on rather than one that says a draft is coming.
    //
    // The branches below read only the id, the card, the customer chat and
    // the creation time, none of which this changes, so they keep using
    // `ticket` rather than the returned row.
    if (actions.includes("time_out_draft")) {
      const timedOut = await ctx.store.timeOutDraft(
        ticket.id,
        MODERATOR_MESSAGES.draftTimedOut(ctx.policy.draftTimeoutMinutes),
      );
      // Null means a draft landed in the same moment, or another sweep got
      // there first. Either way there is nothing to announce.
      if (timedOut) {
        await refreshCard(ctx, timedOut);
        await ctx.store.recordEvent({
          ticketId: timedOut.id,
          event: "draft_timed_out",
          detail: `no draft after ${ctx.policy.draftTimeoutMinutes} min`,
        });
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "draft timed out",
            ticketId: timedOut.id,
            afterMinutes: ctx.policy.draftTimeoutMinutes,
          }),
        );
        summary.draftsTimedOut += 1;
      }
    }

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

  // Record the end of interactions the customer simply stopped replying to.
  //
  // The handler closes a stale conversation lazily when the next question
  // arrives, which is what keeps threading correct. This is the other half:
  // a customer who never comes back would otherwise leave a conversation open
  // for ever and `ended_at` unwritten -- so the interactions that ended
  // quietest would be exactly the ones with no recorded end.
  //
  // Last in the sweep, and deliberately not allowed to fail the rest: nudging
  // a moderator about a waiting customer matters more than a timestamp.
  try {
    const closed = await ctx.store.closeExpiredConversations(
      { followupMinutes: ctx.followupMinutes, idleMinutes: ctx.conversationIdleMinutes },
      MAX_CONVERSATIONS_PER_SWEEP,
    );
    summary.conversationsClosed = closed.length;
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "closing idle conversations failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return summary;
}
