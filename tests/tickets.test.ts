import { describe, expect, it } from "vitest";

import {
  canModeratorAct,
  hasSendableDraft,
  isTerminal,
  ticketRef,
  type Ticket,
} from "../src/core/tickets.js";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 7,
    customerChatId: 111,
    customerUserId: 111,
    customerName: "Sok Dara",
    customerUsername: "sokdara",
    question: "How do I apply for a loan?",
    questionLanguage: "en",
    draft: "Visit your nearest branch with your ID card.",
    draftError: null,
    finalAnswer: null,
    status: "awaiting",
    claimedBy: null,
    claimedByName: null,
    cardMessageId: 900,
    promptMessageId: null,
    createdAt: new Date("2026-10-07T00:00:00Z"),
    updatedAt: new Date("2026-10-07T00:00:00Z"),
    ...overrides,
  };
}

describe("isTerminal", () => {
  it("treats sent and rejected as final and nothing else", () => {
    expect(isTerminal("sent")).toBe(true);
    expect(isTerminal("rejected")).toBe(true);
    expect(isTerminal("drafting")).toBe(false);
    expect(isTerminal("awaiting")).toBe(false);
    expect(isTerminal("claimed")).toBe(false);
  });
});

describe("canModeratorAct", () => {
  it("allows any moderator to take an unclaimed ticket", () => {
    expect(canModeratorAct(ticket(), 555)).toEqual({ ok: true });
  });

  it("allows acting on a ticket still being drafted", () => {
    // A moderator may start writing before Claude finishes.
    expect(canModeratorAct(ticket({ status: "drafting" }), 555)).toEqual({ ok: true });
  });

  it("lets the holder act again", () => {
    const held = ticket({ status: "claimed", claimedBy: 555, claimedByName: "Mod A" });
    expect(canModeratorAct(held, 555)).toEqual({ ok: true });
  });

  it("blocks a second moderator from a held ticket", () => {
    const held = ticket({ status: "claimed", claimedBy: 555, claimedByName: "Mod A" });
    expect(canModeratorAct(held, 999)).toEqual({ ok: false, reason: "held_by_other" });
  });

  it("blocks everyone from a resolved ticket, including whoever resolved it", () => {
    const sent = ticket({ status: "sent", claimedBy: 555, finalAnswer: "done" });
    expect(canModeratorAct(sent, 555)).toEqual({ ok: false, reason: "resolved" });
    expect(canModeratorAct(sent, 999)).toEqual({ ok: false, reason: "resolved" });
    expect(canModeratorAct(ticket({ status: "rejected" }), 555)).toEqual({
      ok: false,
      reason: "resolved",
    });
  });

  it("reports a missing ticket distinctly from a resolved one", () => {
    expect(canModeratorAct(null, 555)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("hasSendableDraft", () => {
  it("accepts a real draft", () => {
    expect(hasSendableDraft(ticket())).toBe(true);
  });

  it("rejects absent, empty and whitespace-only drafts", () => {
    // Each of these would otherwise let a moderator send a blank message.
    expect(hasSendableDraft(ticket({ draft: null }))).toBe(false);
    expect(hasSendableDraft(ticket({ draft: "" }))).toBe(false);
    expect(hasSendableDraft(ticket({ draft: "   \n  " }))).toBe(false);
  });
});

describe("ticketRef", () => {
  it("formats the reference moderators see", () => {
    expect(ticketRef({ id: 7 })).toBe("#7");
  });
});
