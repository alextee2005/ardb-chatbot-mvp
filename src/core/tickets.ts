/**
 * Ticket lifecycle.
 *
 * A ticket is one customer question travelling from arrival to answered. The
 * state machine lives here, separate from both Telegram and the database, so
 * the rules about who may do what to a ticket are testable without either.
 */

import type { Language } from "./language.js";

export type TicketStatus =
  /** Question stored; Claude is drafting. No card in the moderator group yet. */
  | "drafting"
  /** Card posted to the moderator group, nobody has claimed it. */
  | "awaiting"
  /** A moderator holds it -- either reviewing a draft or typing a replacement. */
  | "claimed"
  /** Answer delivered to the customer. Terminal. */
  | "sent"
  /** Moderator declined to answer through the bot. Terminal. */
  | "rejected";

export interface Ticket {
  id: number;
  customerChatId: number;
  customerUserId: number;
  customerName: string;
  customerUsername: string | null;
  question: string;
  questionLanguage: Language;
  draft: string | null;
  draftError: string | null;
  finalAnswer: string | null;
  status: TicketStatus;
  /** Telegram user ID of the moderator holding or who resolved the ticket. */
  claimedBy: number | null;
  claimedByName: string | null;
  /** message_id of the ticket card in the moderator group. */
  cardMessageId: number | null;
  /** message_id of the force-reply prompt, when a moderator is typing an edit. */
  promptMessageId: number | null;
  /** How many times the moderator group has been nudged about this ticket. */
  nudgeCount: number;
  lastNudgedAt: Date | null;
  /** When the customer was told it is taking longer than usual. Once only. */
  customerWarnedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const TERMINAL_STATUSES: readonly TicketStatus[] = ["sent", "rejected"];

export function isTerminal(status: TicketStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Short display reference used in moderator-facing text. */
export function ticketRef(ticket: Pick<Ticket, "id">): string {
  return `#${ticket.id}`;
}

export type ClaimOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "resolved" | "held_by_other" };

/**
 * Decide whether `moderatorId` may act on this ticket.
 *
 * Re-claiming a ticket you already hold is allowed -- a moderator who taps
 * ✏️ Edit after tapping it once should not be told someone else has it.
 */
export function canModeratorAct(
  ticket: Ticket | null,
  moderatorId: number,
): ClaimOutcome {
  if (!ticket) return { ok: false, reason: "not_found" };
  if (isTerminal(ticket.status)) return { ok: false, reason: "resolved" };
  if (ticket.status === "claimed" && ticket.claimedBy !== moderatorId) {
    return { ok: false, reason: "held_by_other" };
  }
  return { ok: true };
}

/**
 * Whether a draft is worth showing as a one-tap "Send as-is" option.
 *
 * A failed or empty draft still produces a card -- the moderator needs to know
 * a customer is waiting -- but without the ✅ button, so nobody can approve
 * nothing by reflex.
 */
export function hasSendableDraft(ticket: Ticket): boolean {
  return ticket.draft !== null && ticket.draft.trim().length > 0;
}
