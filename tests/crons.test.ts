import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The cron dispatch matches `event.cron` against string literals in
 * worker.ts. Nothing in the type system connects those to the schedules in
 * wrangler.jsonc, so a schedule edited in one place and not the other fails
 * silently and in the worst possible way: the Worker keeps running, the
 * expression no longer matches, and the weekly archive quietly becomes an
 * every-minute engagement sweep. These tests are the connection.
 */

const wrangler = readFileSync("wrangler.jsonc", "utf8");
const worker = readFileSync("src/worker.ts", "utf8");

function configuredCrons(): string[] {
  const block = /"crons":\s*\[([\s\S]*?)\]/.exec(wrangler);
  const body = block?.[1];
  expect(body, "wrangler.jsonc should declare triggers.crons").toBeDefined();
  return [...body!.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}

function literal(name: string): string {
  const found = new RegExp(`const ${name} = "([^"]+)"`).exec(worker);
  const value = found?.[1];
  expect(value, `${name} should be declared in worker.ts`).toBeDefined();
  return value!;
}

describe("cron schedules", () => {
  it("declares every schedule the dispatch matches on", () => {
    const crons = configuredCrons();
    expect(crons).toContain(literal("SLA_CRON"));
    expect(crons).toContain(literal("WEEKLY_ARCHIVE_CRON"));
  });

  it("has a minute schedule for the follow-up to be punctual on", () => {
    // The follow-up is due 3 minutes after an answer. On a 5-minute sweep it
    // would arrive somewhere between 3 and 8, and a late "anything else?"
    // reads as though the bot was not paying attention.
    expect(configuredCrons()).toContain("* * * * *");
  });

  it("leaves exactly one schedule falling through to the engagement sweep", () => {
    // The fallback is deliberate, but it should be the minute schedule and
    // only that -- if a second expression started falling through, one of the
    // named sweeps would have stopped running.
    const named = [literal("SLA_CRON"), literal("WEEKLY_ARCHIVE_CRON")];
    const fallthrough = configuredCrons().filter((cron) => !named.includes(cron));
    expect(fallthrough).toEqual(["* * * * *"]);
  });

  it("runs the archive weekly, not on the hour", () => {
    // Schedules on the hour are the most contended, so a weekly job that must
    // actually run is given an odd minute.
    const [minute, hour, dom, month, dow] = literal("WEEKLY_ARCHIVE_CRON").split(" ");
    expect(dow).not.toBe("*");
    expect(dom).toBe("*");
    expect(month).toBe("*");
    expect(minute).not.toBe("0");
    expect(Number(hour)).toBeGreaterThanOrEqual(0);
  });

  it("names the day of the week instead of numbering it", () => {
    // Cloudflare numbers this field 1 = Sunday through 7 = Saturday, which is
    // not what standard crontab means: there 0 = Sunday. Both ways of getting
    // it wrong are bad and only one is loud -- "0" is rejected by the
    // schedules API after the Worker has already uploaded, leaving the code
    // live and the triggers half-applied, while "7" deploys cleanly and runs
    // the weekly archive on Saturday.
    //
    // A name cannot be misread either way, so every schedule that pins a
    // weekday must use one. Asserted across wrangler.jsonc, not just the
    // literal, because the file is the source of truth for what Cloudflare is
    // actually sent.
    for (const cron of configuredCrons()) {
      const dow = cron.split(" ")[4];
      expect(dow, `day-of-week in "${cron}"`).toBeDefined();
      if (dow === "*") continue;
      expect(dow, `"${cron}" should name the weekday, not number it`).toMatch(
        /^(MON|TUE|WED|THU|FRI|SAT|SUN)(-(MON|TUE|WED|THU|FRI|SAT|SUN))?$/,
      );
    }
  });
});
