import { describe, expect, it } from "vitest";

import {
  conversationRef,
  DEFAULT_FOLLOWUP_MINUTES,
  DEFAULT_HISTORY_RETENTION_YEARS,
  DEFAULT_IDLE_MINUTES,
  isConversationOver,
  isOpen,
  isSurveyScore,
  shouldAskFollowup,
  shouldSendSurvey,
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
    followupSentAt: null,
    followupMessageId: null,
    surveySentAt: null,
    surveyMessageId: null,
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

describe("isConversationOver", () => {
  const start = new Date("2026-10-19T08:00:00Z");
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
  const policy = { followupMinutes: 60, idleMinutes: 60 };

  describe("when no follow-up has been sent", () => {
    it("waits for both windows, not just the idle one", () => {
      // The backstop. A conversation whose last question is still unanswered
      // never becomes eligible for a follow-up, so without the sum it would
      // stay open for ever and never be surveyed.
      const c = conversation({ lastActivityAt: start });
      expect(isConversationOver(c, policy, at(60))).toBe(false);
      expect(isConversationOver(c, policy, at(119))).toBe(false);
      expect(isConversationOver(c, policy, at(120))).toBe(true);
    });

    it("leaves room for the follow-up to be asked first", () => {
      // The bug this guards against, and the reason the two windows are
      // separate numbers. The sweep closes conversations before it asks
      // follow-ups, and only an open conversation can be asked. If closing
      // came due at the same instant as asking, the follow-up would never be
      // sent -- the feature would go quiet with nothing failing.
      const c = conversation({ lastActivityAt: start, questionCount: 1 });
      const askAt = at(policy.followupMinutes);
      expect(
        shouldAskFollowup(c, { ...policy, hasPendingQuestion: false, now: askAt }),
      ).toBe(true);
      expect(isConversationOver(c, policy, askAt)).toBe(false);
    });
  });

  describe("when a follow-up has been sent", () => {
    it("measures from the follow-up, not the last activity", () => {
      // The customer was asked a direct question; the clock restarts from the
      // asking, so they get the full window to answer it.
      const c = conversation({ lastActivityAt: start, followupSentAt: at(60) });
      expect(isConversationOver(c, policy, at(119))).toBe(false);
      expect(isConversationOver(c, policy, at(120))).toBe(true);
    });

    it("does not inherit the longer unsent-follow-up deadline", () => {
      // A follow-up sent late must not get both windows again.
      const c = conversation({ lastActivityAt: start, followupSentAt: at(200) });
      expect(isConversationOver(c, policy, at(259))).toBe(false);
      expect(isConversationOver(c, policy, at(260))).toBe(true);
    });
  });

  it("is never true for a conversation already closed", () => {
    // Otherwise the sweep would keep rewriting ended_at and move the recorded
    // end of an interaction every time it ran.
    const c = conversation({ status: "closed", lastActivityAt: start });
    expect(isConversationOver(c, policy, at(6000))).toBe(false);
  });

  it("measures from the last activity, not the start", () => {
    // A long conversation that is still going must not be cut off mid-thread.
    const c = conversation({ startedAt: start, lastActivityAt: at(300) });
    expect(isConversationOver(c, policy, at(310))).toBe(false);
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

describe("shouldAskFollowup", () => {
  const start = new Date("2026-10-19T08:00:00Z");
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
  const answered = { followupMinutes: 60, hasPendingQuestion: false, now: at(60) };

  it("asks once the window has passed with nothing pending", () => {
    const c = conversation({ lastActivityAt: start, questionCount: 1 });
    expect(shouldAskFollowup(c, answered)).toBe(true);
    expect(shouldAskFollowup(c, { ...answered, now: at(59) })).toBe(false);
  });

  it("never asks while a question is still waiting for an answer", () => {
    // "Is there anything else?" sent while the customer is still waiting
    // reads as though the bot forgot the question. At an hour it is rarer than
    // it was at three minutes, but a question stuck in the queue overnight is
    // exactly when it would be most insulting.
    const c = conversation({ lastActivityAt: start, questionCount: 1 });
    expect(shouldAskFollowup(c, { ...answered, hasPendingQuestion: true })).toBe(false);
    expect(shouldAskFollowup(c, { ...answered, hasPendingQuestion: true, now: at(600) })).toBe(
      false,
    );
  });

  it("asks only once per answer", () => {
    const c = conversation({ lastActivityAt: start, questionCount: 1, followupSentAt: at(60) });
    expect(shouldAskFollowup(c, { ...answered, now: at(600) })).toBe(false);
  });

  it("does not ask when nothing was ever asked", () => {
    // Someone who typed /start and wandered off has had no interaction, so
    // there is nothing to follow up on.
    const c = conversation({ lastActivityAt: start, questionCount: 0 });
    expect(shouldAskFollowup(c, { ...answered, now: at(600) })).toBe(false);
  });

  it("does not ask on a closed conversation", () => {
    const c = conversation({ lastActivityAt: start, questionCount: 1, status: "closed" });
    expect(shouldAskFollowup(c, answered)).toBe(false);
  });
});

describe("shouldSendSurvey", () => {
  it("surveys a closed conversation that had questions, once", () => {
    const closed = conversation({ status: "closed", questionCount: 2 });
    expect(shouldSendSurvey(closed)).toBe(true);
    expect(shouldSendSurvey({ ...closed, surveySentAt: new Date() })).toBe(false);
  });

  it("does not survey an interaction that has not ended", () => {
    expect(shouldSendSurvey(conversation({ status: "open", questionCount: 2 }))).toBe(false);
  });

  it("does not survey a conversation in which nothing was asked", () => {
    expect(shouldSendSurvey(conversation({ status: "closed", questionCount: 0 }))).toBe(false);
  });

  it("surveys whatever the reason for ending", () => {
    // A score against "idle" means something different from one against
    // "completed", but both interactions happened and both are worth rating.
    for (const reason of ["idle", "completed", "moderator", "restarted"] as const) {
      expect(
        shouldSendSurvey(conversation({ status: "closed", questionCount: 1, endedReason: reason })),
      ).toBe(true);
    }
  });
});

describe("isSurveyScore", () => {
  it("accepts 1 to 5 and nothing else", () => {
    for (const score of [1, 2, 3, 4, 5]) expect(isSurveyScore(score)).toBe(true);
    for (const bad of [0, 6, -1, 2.5, Number.NaN, 100]) expect(isSurveyScore(bad)).toBe(false);
  });
});

describe("the shipped defaults", () => {
  const start = new Date("2026-10-19T08:00:00Z");
  const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
  const policy = {
    followupMinutes: DEFAULT_FOLLOWUP_MINUTES,
    idleMinutes: DEFAULT_IDLE_MINUTES,
  };

  it("are 30 minutes to the follow-up and 60 more to the close", () => {
    expect(DEFAULT_FOLLOWUP_MINUTES).toBe(30);
    expect(DEFAULT_IDLE_MINUTES).toBe(60);
    expect(DEFAULT_HISTORY_RETENTION_YEARS).toBe(10);
  });

  it("ask the follow-up strictly before closing the conversation", () => {
    // The invariant, asserted against whatever the defaults become rather
    // than against 30 and 60. The sweep closes conversations before it asks
    // follow-ups and only an open conversation can be asked, so if these ever
    // came due together the follow-up would silently never be sent.
    const c = conversation({ lastActivityAt: start, questionCount: 1 });

    const askAt = policy.followupMinutes;
    expect(
      shouldAskFollowup(c, { ...policy, hasPendingQuestion: false, now: at(askAt) }),
    ).toBe(true);
    expect(isConversationOver(c, policy, at(askAt))).toBe(false);

    // And the backstop still fires eventually, for a conversation that never
    // became eligible for a follow-up at all.
    const backstop = policy.followupMinutes + policy.idleMinutes;
    expect(isConversationOver(c, policy, at(backstop))).toBe(true);
  });

  it("give the customer the full idle window to answer the follow-up", () => {
    const asked = conversation({ lastActivityAt: start, followupSentAt: at(30) });
    expect(isConversationOver(asked, policy, at(30 + policy.idleMinutes - 1))).toBe(false);
    expect(isConversationOver(asked, policy, at(30 + policy.idleMinutes))).toBe(true);
  });
});
