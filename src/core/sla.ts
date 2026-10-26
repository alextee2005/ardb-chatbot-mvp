/**
 * Deciding when an unanswered ticket needs a nudge.
 *
 * Pure: takes a ticket, the current time and a policy, and returns what should
 * happen. No clock of its own and no I/O, so every rule below is testable
 * without a database or a fake timer.
 */

import { isTerminal, type Ticket } from "./tickets.js";

export interface SlaPolicy {
  /** Silence before the moderator group is nudged at all. */
  nudgeAfterMinutes: number;
  /** Minimum gap between repeat nudges on the same ticket. */
  nudgeRepeatMinutes: number;
  /**
   * Cap on nudges per ticket. Past this the ticket stays open and visible but
   * stops pinging -- a group that gets nudged indefinitely learns to mute the
   * bot, which costs more than it gains.
   */
  maxNudges: number;
  /** Silence before the customer is told it is taking longer than usual. */
  warnCustomerAfterMinutes: number;
  /**
   * How long a ticket may sit in `drafting` before the draft is given up on.
   *
   * A ticket only leaves `drafting` when the drafting step comes back. If that
   * step never runs -- a misconfigured provider, a dispatch that went nowhere,
   * a runner that died -- the ticket stays there for ever, and the moderator
   * card keeps saying "Claude is drafting a response…" about something that is
   * not coming. The nudges still fire, but they point at a card with no
   * buttons on it, which tells a moderator to keep waiting.
   *
   * Past this, the ticket is moved to `awaiting` and the card is rewritten
   * with Edit and Reject, so the question becomes answerable by hand.
   */
  draftTimeoutMinutes: number;
}

export const DEFAULT_SLA_POLICY: SlaPolicy = {
  nudgeAfterMinutes: 10,
  nudgeRepeatMinutes: 30,
  maxNudges: 3,
  warnCustomerAfterMinutes: 45,
  // Ten times the time the slowest route legitimately takes -- the GitHub
  // route has to boot a runner and install the CLI, which is 30 to 60
  // seconds -- and deliberately below nudgeAfterMinutes, so the card is
  // already actionable by the time anyone is pinged about it.
  draftTimeoutMinutes: 5,
};

export type SlaAction = "nudge_moderators" | "warn_customer" | "time_out_draft";

/** Fields the decision depends on -- a subset, so tests need not build a full ticket. */
export type SlaTicket = Pick<
  Ticket,
  "status" | "createdAt" | "nudgeCount" | "lastNudgedAt" | "customerWarnedAt"
>;

function minutesBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / 60_000;
}

export function decideSlaActions(
  ticket: SlaTicket,
  now: Date,
  policy: SlaPolicy = DEFAULT_SLA_POLICY,
): SlaAction[] {
  // A resolved ticket is never late, however long it took to get there.
  if (isTerminal(ticket.status)) return [];

  const actions: SlaAction[] = [];
  const ageMinutes = minutesBetween(now, ticket.createdAt);

  // First, because the other two are about a ticket nobody has answered and
  // this is about one nobody *can* answer. Giving up on the draft turns a
  // card with no buttons into one with Edit and Reject, so a nudge decided in
  // the same pass points at something a moderator can act on.
  if (ticket.status === "drafting" && ageMinutes >= policy.draftTimeoutMinutes) {
    actions.push("time_out_draft");
  }

  if (shouldNudge(ticket, now, policy, ageMinutes)) {
    actions.push("nudge_moderators");
  }

  // Once only. A customer who has been told it is slow does not need telling
  // again; the next thing they should hear is the answer.
  if (
    ticket.customerWarnedAt === null &&
    ageMinutes >= policy.warnCustomerAfterMinutes
  ) {
    actions.push("warn_customer");
  }

  return actions;
}

function shouldNudge(
  ticket: SlaTicket,
  now: Date,
  policy: SlaPolicy,
  ageMinutes: number,
): boolean {
  if (ticket.nudgeCount >= policy.maxNudges) return false;
  if (ageMinutes < policy.nudgeAfterMinutes) return false;

  // Never nudged and old enough: nudge.
  if (ticket.lastNudgedAt === null) return true;

  return minutesBetween(now, ticket.lastNudgedAt) >= policy.nudgeRepeatMinutes;
}

/**
 * How long a ticket has been waiting, phrased for the nudge message.
 * Whole minutes under an hour, then hours and minutes.
 */
export function formatWaiting(ticket: Pick<Ticket, "createdAt">, now: Date): string {
  const totalMinutes = Math.max(0, Math.floor(minutesBetween(now, ticket.createdAt)));
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
