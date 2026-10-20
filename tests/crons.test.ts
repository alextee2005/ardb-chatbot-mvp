import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { scheduledWork } from "../src/core/schedule.js";

const wrangler = readFileSync("wrangler.jsonc", "utf8");

function configuredCrons(): string[] {
  const block = /"crons":\s*\[([\s\S]*?)\]/.exec(wrangler);
  const body = block?.[1];
  expect(body, "wrangler.jsonc should declare triggers.crons").toBeDefined();
  return [...body!.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

/** A UTC instant, so every assertion below is about the clock Cloudflare uses. */
const at = (iso: string) => new Date(`${iso}Z`);

describe("the Cron Trigger configuration", () => {
  it("declares exactly one schedule", () => {
    // The Workers Free plan allows 5 cron triggers per ACCOUNT, not per
    // Worker. Three did not fit alongside what this account already had, and
    // the deploy failed after the Worker had uploaded -- leaving the code live
    // with its triggers half-applied. One is both sufficient and frugal.
    expect(configuredCrons()).toEqual(["* * * * *"]);
  });

  it("pins no weekday in cron syntax at all", () => {
    // Cloudflare numbers the day-of-week field 1 = Sunday through 7 =
    // Saturday, where crontab uses 0 = Sunday. "0" is rejected by the
    // schedules API and "7" would silently mean Saturday. The schedule now
    // lives in TypeScript, where the day is a tested constant rather than a
    // character in a string -- so no cron expression here should name or
    // number a weekday.
    for (const cron of configuredCrons()) {
      expect(cron.split(" ")[4], `day-of-week in "${cron}"`).toBe("*");
    }
  });
});

describe("scheduledWork", () => {
  it("sweeps engagement every minute", () => {
    // The follow-up is due 30 minutes after the last activity and the survey
    // the moment a conversation closes; both should arrive when they are meant
    // to rather than up to five minutes late.
    for (const minute of [0, 1, 7, 29, 30, 59]) {
      const now = at(`2026-10-20T12:${String(minute).padStart(2, "0")}:00`);
      expect(scheduledWork(now).engagement).toBe(true);
    }
  });

  it("sweeps SLA every fifth minute and no other", () => {
    expect(scheduledWork(at("2026-10-20T12:00:00")).sla).toBe(true);
    expect(scheduledWork(at("2026-10-20T12:05:00")).sla).toBe(true);
    expect(scheduledWork(at("2026-10-20T12:55:00")).sla).toBe(true);
    for (const minute of [1, 2, 3, 4, 6, 29, 59]) {
      const now = at(`2026-10-20T12:${String(minute).padStart(2, "0")}:00`);
      expect(scheduledWork(now).sla, `minute ${minute}`).toBe(false);
    }
  });

  describe("the weekly archive", () => {
    // 2026-10-25 is a Sunday; 2026-10-26 is the Monday after it.
    it("runs on Sunday at 03:17 UTC", () => {
      expect(at("2026-10-25T03:17:00").getUTCDay()).toBe(0); // the fixture is really a Sunday
      expect(scheduledWork(at("2026-10-25T03:17:00")).archive).toBe(true);
    });

    it("retries at 03:47, so one missed invocation does not skip the week", () => {
      // The archive is idempotent: a second run either finds nothing or
      // continues working through a backlog a batch at a time.
      expect(scheduledWork(at("2026-10-25T03:47:00")).archive).toBe(true);
    });

    it("does not run at other minutes, hours or days", () => {
      expect(scheduledWork(at("2026-10-25T03:18:00")).archive).toBe(false);
      expect(scheduledWork(at("2026-10-25T03:00:00")).archive).toBe(false);
      expect(scheduledWork(at("2026-10-25T04:17:00")).archive).toBe(false);
      expect(scheduledWork(at("2026-10-26T03:17:00")).archive).toBe(false);
      expect(scheduledWork(at("2026-10-24T03:17:00")).archive).toBe(false);
    });

    it("runs at most twice a week", () => {
      // Walk a whole week minute by minute. A clock bug that fired the
      // archive hourly would be invisible in a spot check and expensive in
      // production, since each run does real deletes.
      let fired = 0;
      const start = at("2026-10-19T00:00:00").getTime();
      for (let minute = 0; minute < 7 * 24 * 60; minute += 1) {
        if (scheduledWork(new Date(start + minute * 60_000)).archive) fired += 1;
      }
      expect(fired).toBe(2);
    });

    it("is not confused by the hour being 3 in local time elsewhere", () => {
      // Cloudflare invokes on UTC and getUTC* reports UTC, so a date written
      // with an offset must still be judged by its UTC hour.
      const notThreeUtc = new Date("2026-10-25T03:17:00+07:00"); // 20:17 UTC Saturday
      expect(scheduledWork(notThreeUtc).archive).toBe(false);
    });
  });

  it("can have all three due on the same minute", () => {
    // 03:15 is a multiple of five; 03:17 is not. The archive minute is
    // deliberately odd, so in practice the archive coincides with engagement
    // only -- but the handler runs whatever is due in sequence, so this
    // documents that overlap is allowed rather than impossible.
    const sundayArchive = scheduledWork(at("2026-10-25T03:17:00"));
    expect(sundayArchive).toEqual({ engagement: true, sla: false, archive: true });

    const everyFifth = scheduledWork(at("2026-10-25T03:15:00"));
    expect(everyFifth).toEqual({ engagement: true, sla: true, archive: false });
  });
});
