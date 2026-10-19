import { describe, expect, it } from "vitest";

import { escapeHtml, renderCard, renderKeyboard } from "../src/core/moderator-card.js";
import type { Ticket } from "../src/core/tickets.js";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 12,
    conversationId: null,
    customerChatId: 111,
    customerUserId: 111,
    customerName: "Sok Dara",
    customerUsername: "sokdara",
    question: "What documents do I need?",
    questionLanguage: "en",
    draft: "Bring your national ID card and land title.",
    draftError: null,
    finalAnswer: null,
    status: "awaiting",
    claimedBy: null,
    claimedByName: null,
    cardMessageId: 900,
    promptMessageId: null,
    nudgeCount: 0,
    lastNudgedAt: null,
    customerWarnedAt: null,
    createdAt: new Date("2026-10-07T00:00:00Z"),
    updatedAt: new Date("2026-10-07T00:00:00Z"),
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes the characters Telegram's HTML mode treats as markup", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });

  it("leaves Khmer script untouched", () => {
    expect(escapeHtml("សួស្តី")).toBe("សួស្តី");
  });
});

describe("renderCard", () => {
  it("shows the question, the draft and the answer language", () => {
    const card = renderCard(ticket());
    expect(card).toContain("#12");
    expect(card).toContain("Sok Dara");
    expect(card).toContain("@sokdara");
    expect(card).toContain("English");
    expect(card).toContain("What documents do I need?");
    expect(card).toContain("Bring your national ID card and land title.");
  });

  it("escapes a question containing markup", () => {
    // A customer typing "<b>" must not break the card or inject formatting.
    const card = renderCard(ticket({ question: "Is <b>ARDB</b> open?" }));
    expect(card).toContain("Is &lt;b&gt;ARDB&lt;/b&gt; open?");
    expect(card).not.toContain("<b>ARDB</b>");
  });

  it("surfaces a draft failure instead of pretending there is a draft", () => {
    const card = renderCard(
      ticket({ draft: null, draftError: "Claude is rate limiting the bot." }),
    );
    expect(card).toContain("Claude is rate limiting the bot.");
  });

  it("says the draft is still coming while drafting", () => {
    const card = renderCard(ticket({ status: "drafting", draft: null }));
    expect(card).toContain("drafting");
  });

  it("distinguishes an edited answer from one sent as drafted", () => {
    const asDrafted = renderCard(
      ticket({
        status: "sent",
        finalAnswer: "Bring your national ID card and land title.",
        claimedByName: "Mod A",
      }),
    );
    expect(asDrafted).toContain("as drafted");

    const edited = renderCard(
      ticket({ status: "sent", finalAnswer: "Bring your ID card only.", claimedByName: "Mod A" }),
    );
    expect(edited).toContain("(edited)");
    expect(edited).toContain("Bring your ID card only.");
  });

  it("names the holder of an in-progress ticket", () => {
    const card = renderCard(ticket({ status: "claimed", claimedByName: "Mod B" }));
    expect(card).toContain("Mod B");
  });

  it("stays within Telegram's 4096-character message limit", () => {
    const card = renderCard(
      ticket({ question: "ក".repeat(5000), draft: "x".repeat(5000) }),
    );
    expect(card.length).toBeLessThanOrEqual(4096);
  });

  it("omits the handle for a customer without a username", () => {
    expect(renderCard(ticket({ customerUsername: null }))).not.toContain("@");
  });
});

describe("renderKeyboard", () => {
  it("offers send, edit and reject when there is a draft", () => {
    const keyboard = renderKeyboard(ticket());
    const labels = keyboard?.inline_keyboard[0]?.map((button) => button.text) ?? [];
    expect(labels).toEqual(["✅ Send as-is", "✏️ Edit", "🚫 Reject"]);
  });

  it("withholds send-as-is when the draft failed", () => {
    // Nobody should be able to approve an empty answer with one tap.
    const keyboard = renderKeyboard(ticket({ draft: null, draftError: "failed" }));
    const labels = keyboard?.inline_keyboard[0]?.map((button) => button.text) ?? [];
    expect(labels).toEqual(["✏️ Edit", "🚫 Reject"]);
  });

  it("removes every button once the ticket is resolved", () => {
    expect(renderKeyboard(ticket({ status: "sent" }))).toBeUndefined();
    expect(renderKeyboard(ticket({ status: "rejected" }))).toBeUndefined();
  });
});

describe("the conversation banner", () => {
  const previous = {
    ticketId: 9,
    question: "What documents do I need for a small loan?",
    questionLanguage: "en" as const,
    answer: "Your ID card and your family book.",
    askedAt: new Date("2026-10-19T08:00:00Z"),
  };

  it("is absent for a first question", () => {
    // A banner implying history that does not exist would be worse than none.
    const text = renderCard(ticket());
    expect(text).not.toContain("Conversation:");
    expect(text).toBe(renderCard(ticket(), { turns: [] }));
  });

  it("shows the thread, the position in it, and the previous exchange", () => {
    // Without this a moderator reading "and for a group?" cannot answer it.
    const text = renderCard(ticket({ conversationId: 12, question: "And for a group?" }), {
      turns: [previous],
    });
    expect(text).toContain("C12");
    expect(text).toContain("question 2");
    expect(text).toContain("What documents do I need for a small loan?");
    expect(text).toContain("Your ID card and your family book.");
  });

  it("counts the turns that are not shown", () => {
    const turns = [previous, { ...previous, ticketId: 10 }, { ...previous, ticketId: 11 }];
    const text = renderCard(ticket({ conversationId: 12 }), { turns });
    expect(text).toContain("question 4");
    expect(text).toContain("2 turns before that");
  });

  it("says when the previous question went unanswered", () => {
    const text = renderCard(ticket({ conversationId: 12 }), {
      turns: [{ ...previous, answer: null }],
    });
    expect(text).toContain("No answer was sent for that question.");
  });

  it("escapes and clamps the history like any other borrowed text", () => {
    const text = renderCard(ticket({ conversationId: 12 }), {
      turns: [{ ...previous, question: `<b>${"x".repeat(2000)}`, answer: "a & b" }],
    });
    expect(text).toContain("&lt;b&gt;");
    expect(text).toContain("a &amp; b");
    // Telegram rejects a message over 4096 characters, and the history shares
    // the card with the question and the draft.
    expect(text.length).toBeLessThan(4096);
  });

  it("still names the position when the conversation id is missing", () => {
    // Tickets filed before conversations existed have no id but can still be
    // rendered with turns by a caller that found them some other way.
    const text = renderCard(ticket({ conversationId: null }), { turns: [previous] });
    expect(text).toContain("question 2");
    expect(text).not.toContain("<code>C");
  });
});
