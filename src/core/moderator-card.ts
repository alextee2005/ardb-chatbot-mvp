/**
 * The moderator-facing ticket card.
 *
 * One card per question, carrying everything a moderator needs to decide
 * without leaving the group: who asked, what they asked, what language to
 * answer in, and Claude's draft. The card is edited in place as the ticket
 * moves, so the group reads as a live queue rather than a scroll of history.
 */

import { encodeCallback } from "./callbacks.js";
import { languageLabel } from "./language.js";
import { hasSendableDraft, ticketRef, type Ticket } from "./tickets.js";

/** Telegram's HTML parse mode needs these five escaped, and only these. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

/**
 * Telegram rejects messages over 4096 characters. A long question plus a long
 * draft can cross that, so trim the question first -- the moderator can always
 * scroll the customer's own message, but the draft is the thing they are
 * approving and must be shown whole.
 */
const MAX_QUESTION_CHARS = 1200;
const MAX_DRAFT_CHARS = 2400;

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function customerLine(ticket: Ticket): string {
  const name = escapeHtml(ticket.customerName);
  const handle = ticket.customerUsername
    ? ` (@${escapeHtml(ticket.customerUsername)})`
    : "";
  return `${name}${handle} · <code>${ticket.customerUserId}</code>`;
}

export function renderCard(ticket: Ticket): string {
  const ref = ticketRef(ticket);
  const lines: string[] = [
    `<b>${ref} — ${statusHeadline(ticket)}</b>`,
    "",
    `<b>From:</b> ${customerLine(ticket)}`,
    `<b>Answer in:</b> ${languageLabel(ticket.questionLanguage)}`,
    "",
    "<b>Question</b>",
    `<blockquote>${escapeHtml(clamp(ticket.question, MAX_QUESTION_CHARS))}</blockquote>`,
  ];

  if (ticket.draftError) {
    lines.push("", "<b>Suggested response</b>", `<i>${escapeHtml(ticket.draftError)}</i>`);
  } else if (ticket.draft) {
    lines.push(
      "",
      "<b>Suggested response</b>",
      `<blockquote>${escapeHtml(clamp(ticket.draft, MAX_DRAFT_CHARS))}</blockquote>`,
    );
  } else {
    lines.push("", "<i>Claude is drafting a response…</i>");
  }

  if (ticket.status === "sent" && ticket.finalAnswer) {
    const edited = ticket.finalAnswer.trim() !== (ticket.draft ?? "").trim();
    lines.push(
      "",
      `<b>Sent${edited ? " (edited)" : " as drafted"}</b> by ${escapeHtml(ticket.claimedByName ?? "unknown")}`,
    );
    if (edited) {
      lines.push(
        `<blockquote>${escapeHtml(clamp(ticket.finalAnswer, MAX_DRAFT_CHARS))}</blockquote>`,
      );
    }
  }

  if (ticket.status === "rejected") {
    lines.push("", `<b>Rejected</b> by ${escapeHtml(ticket.claimedByName ?? "unknown")}`);
  }

  if (ticket.status === "claimed") {
    lines.push("", `<i>Held by ${escapeHtml(ticket.claimedByName ?? "a moderator")}</i>`);
  }

  return lines.join("\n");
}

function statusHeadline(ticket: Ticket): string {
  switch (ticket.status) {
    case "drafting":
      return "new question";
    case "awaiting":
      return "awaiting review";
    case "claimed":
      return "in progress";
    case "sent":
      return "answered";
    case "rejected":
      return "rejected";
  }
}

/**
 * Buttons for the ticket's current state. Resolved tickets get none -- the card
 * becomes a read-only record, which is also what makes the group an audit log.
 */
export function renderKeyboard(ticket: Ticket): InlineKeyboard | undefined {
  if (ticket.status === "sent" || ticket.status === "rejected") return undefined;

  const row: { text: string; callback_data: string }[] = [];
  if (hasSendableDraft(ticket)) {
    row.push({ text: "✅ Send as-is", callback_data: encodeCallback("send", ticket.id) });
  }
  row.push({ text: "✏️ Edit", callback_data: encodeCallback("edit", ticket.id) });
  row.push({ text: "🚫 Reject", callback_data: encodeCallback("reject", ticket.id) });

  return { inline_keyboard: [row] };
}
