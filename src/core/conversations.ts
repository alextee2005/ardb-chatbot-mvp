/**
 * Conversations: one customer's interaction, from first question to last.
 *
 * A ticket is one question. A conversation is the thread it belongs to, which
 * is what lets a follow-up be read as a follow-up -- by a moderator looking at
 * the card, and by the model writing the draft.
 *
 * As with tickets, the rules live here rather than in the store or the
 * handler, so they are testable without a database or a Telegram client.
 */

import type { Language } from "./language.js";

export type ConversationStatus = "open" | "closed";

/** Why a conversation ended. Null while it is still open. */
export type ConversationEndReason =
  /** The customer stopped writing and the idle window elapsed. */
  | "idle"
  /** The customer typed /start, which begins a fresh interaction. */
  | "restarted"
  /** A moderator closed it deliberately. */
  | "moderator"
  /**
   * The customer said there was nothing else.
   *
   * The only ending the customer actually confirms, which is why it is worth
   * distinguishing from one that merely went quiet: a satisfaction score
   * attached to "completed" means something different from the same score
   * attached to "idle".
   */
  | "completed";

export interface Conversation {
  id: number;
  customerChatId: number;
  customerUserId: number;
  status: ConversationStatus;
  endedReason: ConversationEndReason | null;
  /** How many questions have been asked in this conversation, including the newest. */
  questionCount: number;
  startedAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;
  /** When "is there anything else?" was asked. Reset on each new question. */
  followupSentAt: Date | null;
  /** The message carrying the Yes/No buttons, so they can be stripped. */
  followupMessageId: number | null;
  surveySentAt: Date | null;
  surveyMessageId: number | null;
}

/**
 * One earlier turn, as the model and the moderator need to see it.
 *
 * `answer` is the text actually delivered to the customer, never a draft: a
 * draft nobody approved was never part of the conversation, and treating one
 * as though it were would have the model build on an answer the customer never
 * received -- and, worse, one a moderator may have rejected as wrong.
 */
export interface ConversationTurn {
  ticketId: number;
  question: string;
  questionLanguage: Language;
  /** Null when the question was never answered through the bot. */
  answer: string | null;
  askedAt: Date;
}

/**
 * How long after the last activity to ask whether anything else is needed.
 *
 * The first half of the ending sequence:
 *
 *   last activity --30 min--> "is there anything else?"
 *                               |-- No  --> closed, 'completed'
 *                               |-- Yes --> back to the start
 *                               `-- ignored --60 min--> closed, 'idle'
 *
 * So an abandoned interaction is recorded as over 90 minutes after the last
 * activity, and one the customer answers ends the moment they answer it.
 */
export const DEFAULT_FOLLOWUP_MINUTES = 30;

/**
 * How long to wait for an answer to the follow-up before giving up.
 *
 * Measured from when the follow-up was sent, not from the last activity, and
 * that distinction is why this is a separate number rather than one window
 * reused. Were both measured from the same instant and set to the same value,
 * the idle close and the follow-up would come due in the same sweep -- and
 * because the sweep closes conversations before it asks follow-ups, and only
 * an open conversation can be asked, the follow-up would never be sent at all.
 * The feature would go quiet with nothing failing.
 *
 * The shipped defaults (30 and 60) do not collide, but the ordering is what
 * makes that safe rather than lucky, and a test asserts it for whatever the
 * defaults become.
 */
export const DEFAULT_IDLE_MINUTES = 60;

/** The two windows that decide when an interaction is over. */
export interface ConversationPolicy {
  /** Quiet minutes after the last activity before asking "anything else?". */
  followupMinutes: number;
  /** Quiet minutes after that question before closing it unanswered. */
  idleMinutes: number;
}

export function isOpen(conversation: Conversation): boolean {
  return conversation.status === "open";
}

/** Short display reference, matching `ticketRef`'s shape. */
export function conversationRef(conversation: Pick<Conversation, "id">): string {
  return `C${conversation.id}`;
}

/**
 * Whether a conversation has been quiet long enough to call it ended.
 *
 * Two branches, because the clock restarts when the follow-up is sent:
 *
 *   follow-up sent     -> idleMinutes from the moment it was sent. The
 *                         customer was asked a direct question and did not
 *                         answer it.
 *   follow-up not sent -> followupMinutes + idleMinutes from the last
 *                         activity. This is the backstop. A conversation whose
 *                         last question is still sitting unanswered in the
 *                         queue never becomes eligible for a follow-up, and
 *                         without the sum it would stay open for ever and
 *                         never be surveyed.
 *
 * Takes `now` explicitly rather than reading the clock, so the boundary is
 * testable rather than something to approximate with a sleep.
 */
export function isConversationOver(
  conversation: Conversation,
  policy: ConversationPolicy,
  now: Date,
): boolean {
  if (!isOpen(conversation)) return false;

  if (conversation.followupSentAt !== null) {
    const elapsed = now.getTime() - conversation.followupSentAt.getTime();
    return elapsed >= policy.idleMinutes * 60_000;
  }

  const elapsed = now.getTime() - conversation.lastActivityAt.getTime();
  return elapsed >= (policy.followupMinutes + policy.idleMinutes) * 60_000;
}

/** How long an archived interaction is kept before it is deleted outright. */
export const DEFAULT_HISTORY_RETENTION_YEARS = 10;

/**
 * How many earlier turns to put in front of the model.
 *
 * The corpus already fills most of the prompt, and a long history pushes the
 * grounding material further from the question without making the answer
 * better. The most recent turns are the ones a follow-up refers to.
 */
export const MAX_HISTORY_TURNS = 6;

/** Characters of each earlier turn to keep. Enough for substance, not an essay. */
const MAX_TURN_CHARS = 600;

function clamp(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

/**
 * Render earlier turns for the drafting prompt.
 *
 * Returns an empty string for a first question, so the prompt is byte-for-byte
 * what it was before conversations existed and nothing changes for the common
 * case.
 *
 * This goes in the user turn, never the system blocks: the system prefix is
 * cached and must stay identical across requests, and history by definition
 * differs every time. Putting it here costs nothing; putting it there would
 * cost the cache hit on every question.
 */
export function renderHistory(turns: readonly ConversationTurn[]): string {
  if (turns.length === 0) return "";

  const recent = turns.slice(-MAX_HISTORY_TURNS);
  const lines: string[] = [
    "Earlier in this same conversation with this customer, oldest first:",
    "",
  ];

  for (const turn of recent) {
    lines.push("<turn>");
    lines.push(`<customer>${clamp(turn.question, MAX_TURN_CHARS)}</customer>`);
    if (turn.answer) {
      lines.push(`<ardb>${clamp(turn.answer, MAX_TURN_CHARS)}</ardb>`);
    } else {
      // Said plainly, because the model must not write as though an answer it
      // cannot see was already given. An unanswered question is usually why
      // the customer is writing again.
      lines.push("<ardb>No answer was sent for this question.</ardb>");
    }
    lines.push("</turn>");
  }

  lines.push(
    "",
    "Treat the newest question below as part of this conversation: it may be a " +
      "follow-up that only makes sense alongside the turns above, and it may " +
      "use words like \"it\" or \"that\" to refer back to them. Do not repeat an " +
      "answer already given; add what is being asked for now. The grounding " +
      "rules apply unchanged -- an earlier answer is not a source, so do not " +
      "treat a figure quoted above as confirmed unless the source material " +
      "also carries it.",
  );

  return lines.join("\n");
}

/**
 * Whether it is time to ask "is there anything else?".
 *
 * Deliberately not just a clock check. The guard that matters is
 * `hasPendingQuestion`: asking whether there is anything else while the
 * customer is still waiting for an answer to the last thing they asked would
 * be worse than saying nothing at all -- it reads as though the bot has
 * forgotten the question. Three minutes is short enough that an unanswered
 * ticket is the normal case, not the exception, so this is the common path
 * rather than an edge case.
 */
export function shouldAskFollowup(
  conversation: Conversation,
  options: { followupMinutes: number; hasPendingQuestion: boolean; now: Date },
): boolean {
  if (!isOpen(conversation)) return false;
  // Asked once per answer. Cleared when a new question arrives, so the
  // customer is asked again after each one.
  if (conversation.followupSentAt !== null) return false;
  if (options.hasPendingQuestion) return false;
  // No questions yet means nothing has been answered, so there is nothing to
  // follow up on -- a /start with no question must not be asked "anything
  // else?" three minutes later.
  if (conversation.questionCount === 0) return false;

  const elapsed = options.now.getTime() - conversation.lastActivityAt.getTime();
  return elapsed >= options.followupMinutes * 60_000;
}

/**
 * Whether this conversation still needs a satisfaction survey.
 *
 * Only closed conversations are surveyed, and only once. An open conversation
 * has not ended, so there is nothing yet to rate.
 */
export function shouldSendSurvey(conversation: Conversation): boolean {
  if (isOpen(conversation)) return false;
  if (conversation.surveySentAt !== null) return false;
  // Nothing was ever asked, so there is no interaction to rate. A customer who
  // typed /start and left should not be surveyed about it.
  return conversation.questionCount > 0;
}

/** The satisfaction scale. Five points, 1 worst to 5 best. */
export const SURVEY_SCORES = [1, 2, 3, 4, 5] as const;
export type SurveyScore = (typeof SURVEY_SCORES)[number];

export function isSurveyScore(value: number): value is SurveyScore {
  return (SURVEY_SCORES as readonly number[]).includes(value);
}
