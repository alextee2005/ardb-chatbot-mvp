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
  | "moderator";

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

/** How long a conversation may sit idle before it is considered over. */
export const DEFAULT_IDLE_MINUTES = 60;

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
 * Takes `now` explicitly rather than reading the clock, so the boundary is
 * testable rather than something to approximate with a sleep.
 */
export function isIdle(
  conversation: Conversation,
  idleMinutes: number,
  now: Date,
): boolean {
  if (!isOpen(conversation)) return false;
  const idleMs = idleMinutes * 60_000;
  return now.getTime() - conversation.lastActivityAt.getTime() >= idleMs;
}

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
