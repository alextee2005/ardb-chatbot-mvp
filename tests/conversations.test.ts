import { describe, expect, it } from "vitest";

import {
  conversationRef,
  isIdle,
  isOpen,
  MAX_HISTORY_TURNS,
  renderHistory,
  type Conversation,
  type ConversationTurn,
} from "../src/core/conversations.js";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 12,
    customerChatId: 555,
    customerUserId: 555,
    status: "open",
    endedReason: null,
    questionCount: 1,
    startedAt: new Date("2026-10-19T08:00:00Z"),
    lastActivityAt: new Date("2026-10-19T08:00:00Z"),
    endedAt: null,
    ...overrides,
  };
}

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    ticketId: 1,
    question: "What documents do I need for a loan?",
    questionLanguage: "en",
    answer: "A copy of your ID card and your family book.",
    askedAt: new Date("2026-10-19T08:00:00Z"),
    ...overrides,
  };
}

describe("isIdle", () => {
  const start = new Date("2026-10-19T08:00:00Z");
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

  it("is false before the window and true at or after it", () => {
    // The boundary is inclusive, so a 60-minute window closes at exactly 60
    // rather than only at 61.
    const c = conversation({ lastActivityAt: start });
    expect(isIdle(c, 60, at(59))).toBe(false);
    expect(isIdle(c, 60, at(60))).toBe(true);
    expect(isIdle(c, 60, at(600))).toBe(true);
  });

  it("measures from the last activity, not the start", () => {
    // A long conversation that is still going must not be cut off mid-thread.
    const c = conversation({ startedAt: start, lastActivityAt: at(90) });
    expect(isIdle(c, 60, at(100))).toBe(false);
  });

  it("is never true for a conversation already closed", () => {
    // Otherwise the sweep would keep rewriting ended_at and move the recorded
    // end of an interaction every time it ran.
    const c = conversation({ status: "closed", lastActivityAt: start });
    expect(isIdle(c, 60, at(600))).toBe(false);
  });
});

describe("isOpen and conversationRef", () => {
  it("reports status and a short reference", () => {
    expect(isOpen(conversation())).toBe(true);
    expect(isOpen(conversation({ status: "closed" }))).toBe(false);
    expect(conversationRef({ id: 12 })).toBe("C12");
  });
});

describe("renderHistory", () => {
  it("renders nothing at all for a first question", () => {
    // Byte-for-byte what the prompt was before conversations existed, so the
    // common case is unchanged.
    expect(renderHistory([])).toBe("");
  });

  it("includes each earlier question and the answer that was sent", () => {
    const text = renderHistory([turn()]);
    expect(text).toContain("What documents do I need for a loan?");
    expect(text).toContain("A copy of your ID card and your family book.");
    expect(text).toContain("<turn>");
  });

  it("says plainly when a question was never answered", () => {
    // The model must not write as though an answer it cannot see was given.
    // An unanswered question is usually why the customer is writing again.
    const text = renderHistory([turn({ answer: null })]);
    expect(text).toContain("No answer was sent for this question.");
  });

  it("keeps the most recent turns when there are more than the cap", () => {
    const turns = Array.from({ length: MAX_HISTORY_TURNS + 3 }, (_, i) =>
      turn({ ticketId: i, question: `question number ${i}` }),
    );
    const text = renderHistory(turns);
    // The oldest fall off; a follow-up refers to what was just said.
    expect(text).not.toContain("question number 0");
    expect(text).toContain(`question number ${MAX_HISTORY_TURNS + 2}`);
    expect(text.match(/<turn>/g)).toHaveLength(MAX_HISTORY_TURNS);
  });

  it("clamps a very long turn", () => {
    const text = renderHistory([turn({ question: "x".repeat(5000) })]);
    expect(text.length).toBeLessThan(2500);
    expect(text).toContain("…");
  });

  it("restates the grounding rules so an earlier answer is not treated as a source", () => {
    // The one real risk of giving the model history: a figure it quoted last
    // turn looks like established fact this turn. For a bank quoting interest
    // rates that is the failure that matters most.
    const text = renderHistory([turn()]);
    expect(text).toContain("an earlier answer is not a source");
  });

  it("tells the model the newest question may refer back", () => {
    expect(renderHistory([turn()])).toContain("follow-up");
  });
});
