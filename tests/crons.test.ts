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
    expect(configuredCrons()).toEqual(["*/5 * * * *"]);
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
  it("sweeps engagement and SLA on every invocation", () => {
    // Both are due every time now. They were on different cadences when the
    // follow-up came after three minutes and needed the precision; at thirty
    // a five-minute sweep is already an order of magnitude finer than the
    // thing it is timing.
    for (const minute of [0, 5, 20, 35, 55]) {
      const now = at(`2026-10-20T12:${String(minute).padStart(2, "0")}:00`);
      expect(scheduledWork(now).engagement, `minute ${minute}`).toBe(true);
      expect(scheduledWork(now).sla, `minute ${minute}`).toBe(true);
    }
  });

  describe("the weekly archive", () => {
    // 2026-10-25 is a Sunday; 2026-10-26 is the Monday after it.
    it("runs on Sunday at 03:20 UTC", () => {
      expect(at("2026-10-25T03:20:00").getUTCDay()).toBe(0); // the fixture is really a Sunday
      expect(scheduledWork(at("2026-10-25T03:20:00")).archive).toBe(true);
    });

    it("retries at 03:50, so one missed invocation does not skip the week", () => {
      // The archive is idempotent: a second run either finds nothing or
      // continues working through a backlog a batch at a time.
      expect(scheduledWork(at("2026-10-25T03:50:00")).archive).toBe(true);
    });

    it("lands on minutes the trigger actually fires on", () => {
      // The guard that matters most here. The trigger is */5, so an archive
      // minute that is not a multiple of five is never reached -- and the
      // symptom is silence: no error, no log line, just history tables that
      // grow for ever.
      const cron = configuredCrons()[0]!;
      const step = /^\*\/(\d+)/.exec(cron.split(" ")[0]!);
      expect(step, `could not read a step from "${cron}"`).not.toBeNull();
      const every = Number(step![1]);

      let fired = false;
      for (let minute = 0; minute < 60; minute += every) {
        if (scheduledWork(at(`2026-10-25T03:${String(minute).padStart(2, "0")}:00`)).archive) {
          fired = true;
        }
      }
      expect(fired, "no archive minute coincides with a trigger invocation").toBe(true);
    });

    it("does not run at other minutes, hours or days", () => {
      expect(scheduledWork(at("2026-10-25T03:25:00")).archive).toBe(false);
      expect(scheduledWork(at("2026-10-25T03:00:00")).archive).toBe(false);
      expect(scheduledWork(at("2026-10-25T04:20:00")).archive).toBe(false);
      expect(scheduledWork(at("2026-10-26T03:20:00")).archive).toBe(false);
      expect(scheduledWork(at("2026-10-24T03:20:00")).archive).toBe(false);
    });

    it("runs at most twice a week", () => {
      // Walk a whole week, every minute, not only the ones the trigger fires
      // on -- a clock bug that fired the archive hourly would be invisible in
      // a spot check and expensive in production, since each run does real
      // deletes.
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

  it("has all three due together on the archive minute", () => {
    // The handler runs whatever is due in sequence, each guarded, so an
    // overlap is ordinary rather than special -- but it should be deliberate
    // and visible here rather than discovered in production.
    expect(scheduledWork(at("2026-10-25T03:20:00"))).toEqual({
      engagement: true,
      sla: true,
      archive: true,
    });
    expect(scheduledWork(at("2026-10-25T03:25:00"))).toEqual({
      engagement: true,
      sla: true,
      archive: false,
    });
  });
});
