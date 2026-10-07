import { describe, expect, it } from "vitest";

import {
  DEFAULT_SLA_POLICY,
  decideSlaActions,
  formatWaiting,
  type SlaPolicy,
  type SlaTicket,
} from "../src/core/sla.js";

const NOW = new Date("2026-10-07T12:00:00Z");

/** A ticket created `minutesAgo` before NOW. */
function waiting(minutesAgo: number, overrides: Partial<SlaTicket> = {}): SlaTicket {
  return {
    status: "awaiting",
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    nudgeCount: 0,
    lastNudgedAt: null,
    customerWarnedAt: null,
    ...overrides,
  };
}

const policy: SlaPolicy = DEFAULT_SLA_POLICY; // 10 / 30 / 3 / 45

describe("decideSlaActions", () => {
  it("leaves a fresh ticket alone", () => {
    expect(decideSlaActions(waiting(2), NOW, policy)).toEqual([]);
  });

  it("does nothing right up to the nudge threshold", () => {
    expect(decideSlaActions(waiting(9), NOW, policy)).toEqual([]);
  });

  it("nudges once the threshold is reached exactly", () => {
    expect(decideSlaActions(waiting(10), NOW, policy)).toEqual(["nudge_moderators"]);
  });

  it("never chases a resolved ticket, however long it took", () => {
    // The answer has already been delivered; there is nothing to chase.
    for (const status of ["sent", "rejected"] as const) {
      expect(decideSlaActions(waiting(600, { status }), NOW, policy)).toEqual([]);
    }
  });

  it("chases a ticket still drafting or already claimed", () => {
    // Claimed is not answered: a moderator may have tapped Edit and wandered off.
    expect(decideSlaActions(waiting(20, { status: "drafting" }), NOW, policy)).toEqual([
      "nudge_moderators",
    ]);
    expect(decideSlaActions(waiting(20, { status: "claimed" }), NOW, policy)).toEqual([
      "nudge_moderators",
    ]);
  });

  describe("repeat nudges", () => {
    it("stays quiet inside the repeat window", () => {
      const ticket = waiting(20, {
        nudgeCount: 1,
        lastNudgedAt: new Date(NOW.getTime() - 10 * 60_000),
      });
      expect(decideSlaActions(ticket, NOW, policy)).toEqual([]);
    });

    it("nudges again once the repeat window has passed", () => {
      const ticket = waiting(45, {
        nudgeCount: 1,
        lastNudgedAt: new Date(NOW.getTime() - 30 * 60_000),
      });
      expect(decideSlaActions(ticket, NOW, policy)).toContain("nudge_moderators");
    });

    it("stops nudging at the cap but keeps the ticket open", () => {
      // A group nudged indefinitely mutes the bot, which costs more than it gains.
      const ticket = waiting(600, {
        nudgeCount: policy.maxNudges,
        lastNudgedAt: new Date(NOW.getTime() - 120 * 60_000),
        customerWarnedAt: new Date(NOW.getTime() - 100 * 60_000),
      });
      expect(decideSlaActions(ticket, NOW, policy)).toEqual([]);
    });
  });

  describe("customer warning", () => {
    it("holds off before the warning threshold", () => {
      const ticket = waiting(44, {
        nudgeCount: 1,
        lastNudgedAt: new Date(NOW.getTime() - 1 * 60_000),
      });
      expect(decideSlaActions(ticket, NOW, policy)).not.toContain("warn_customer");
    });

    it("warns once the threshold is reached", () => {
      const ticket = waiting(45, {
        nudgeCount: 1,
        lastNudgedAt: new Date(NOW.getTime() - 1 * 60_000),
      });
      expect(decideSlaActions(ticket, NOW, policy)).toEqual(["warn_customer"]);
    });

    it("never warns the same customer twice", () => {
      // The next thing they should hear is the answer, not another apology.
      const ticket = waiting(300, {
        nudgeCount: policy.maxNudges,
        customerWarnedAt: new Date(NOW.getTime() - 200 * 60_000),
      });
      expect(decideSlaActions(ticket, NOW, policy)).toEqual([]);
    });

    it("can nudge and warn in the same sweep", () => {
      // A ticket that crossed both thresholds between two sweeps.
      const ticket = waiting(50);
      expect(decideSlaActions(ticket, NOW, policy)).toEqual([
        "nudge_moderators",
        "warn_customer",
      ]);
    });
  });

  it("honours a custom policy", () => {
    const eager: SlaPolicy = {
      nudgeAfterMinutes: 1,
      nudgeRepeatMinutes: 1,
      maxNudges: 10,
      warnCustomerAfterMinutes: 2,
    };
    expect(decideSlaActions(waiting(3), NOW, eager)).toEqual([
      "nudge_moderators",
      "warn_customer",
    ]);
  });
});

describe("formatWaiting", () => {
  it("reports whole minutes under an hour", () => {
    expect(formatWaiting({ createdAt: new Date(NOW.getTime() - 7 * 60_000) }, NOW)).toBe(
      "7 min",
    );
  });

  it("reports hours and minutes beyond an hour", () => {
    expect(
      formatWaiting({ createdAt: new Date(NOW.getTime() - 95 * 60_000) }, NOW),
    ).toBe("1h 35m");
  });

  it("drops the minutes on a whole hour", () => {
    expect(
      formatWaiting({ createdAt: new Date(NOW.getTime() - 120 * 60_000) }, NOW),
    ).toBe("2h");
  });

  it("never reports negative time for a clock skew", () => {
    // Worker and database clocks can disagree by a little.
    expect(
      formatWaiting({ createdAt: new Date(NOW.getTime() + 5 * 60_000) }, NOW),
    ).toBe("0 min");
  });
});
