/**
 * Which sweeps are due on a given minute.
 *
 * The Worker has one Cron Trigger, firing every five minutes, and decides here what
 * each invocation is for. It used to have three triggers and match
 * `event.cron` against string literals, which failed twice in one afternoon:
 *
 *   - Cloudflare numbers the day-of-week field 1 = Sunday, not 0 = Sunday as
 *     crontab does, so "17 3 * * 0" was rejected by the schedules API *after*
 *     the Worker had already uploaded.
 *   - The Workers Free plan allows 5 cron triggers per account, and three of
 *     them did not fit alongside what the account already had.
 *
 * One trigger sidesteps both: there is almost no cron syntax left to get
 * wrong, nothing to keep in step between wrangler.jsonc and the Worker, and
 * four of the account's five slots stay free. The cost is that the schedule
 * lives in code -- which is testable, where a cron string was not.
 *
 * Five minutes rather than every minute because the follow-up is due 30
 * minutes after the last activity, so a five-minute sweep is already an order
 * of magnitude more precise than the thing it is timing. Every minute would
 * mean 1,440 invocations a day, each one querying Postgres -- which on Neon's
 * free tier never lets the compute scale to zero and spends the monthly
 * allowance on finding nothing to do.
 *
 * Times are UTC throughout, because that is what Cloudflare invokes on and
 * what `Date.getUTC*` reports. Taking `now` as an argument rather than
 * reading the clock is what makes every boundary below assertable.
 */

export interface ScheduledWork {
  /** Follow-ups and satisfaction surveys. Every invocation. */
  engagement: boolean;
  /** Nudging moderators about unanswered tickets. Every invocation. */
  sla: boolean;
  /** Archiving and purging closed conversations. Weekly. */
  archive: boolean;
}

/**
 * Minutes past the hour for the weekly archive, and its retry.
 *
 * Both must be multiples of five, or the five-minute trigger never lands on
 * them
 * and the archive never runs at all. A test asserts it, because the symptom
 * would be silence: no error, no log line, just a table that grows for ever.
 */
const ARCHIVE_MINUTES = [20, 50];
/** UTC hour for the weekly archive. */
const ARCHIVE_HOUR = 3;
/** `Date.getUTCDay()` is 0 for Sunday -- the JavaScript convention, not Cloudflare's. */
const ARCHIVE_DAY = 0;

export function scheduledWork(now: Date): ScheduledWork {
  const minute = now.getUTCMinutes();

  return {
    // Both run on every invocation. They were on different cadences when the
    // follow-up was due after three minutes and needed the precision; at
    // thirty it does not, and the SLA sweep's thresholds start at ten.
    engagement: true,
    sla: true,

    // Sunday 03:20 UTC, with a retry at 03:50. Two attempts rather than one
    // because a single missed invocation would skip the week entirely, and
    // the archive is idempotent -- a second run either finds nothing to do or
    // continues working through a backlog a batch at a time.
    //
    // Not on the hour: those schedules are the most contended, and this one
    // only gets 52 chances a year.
    archive:
      now.getUTCDay() === ARCHIVE_DAY &&
      now.getUTCHours() === ARCHIVE_HOUR &&
      ARCHIVE_MINUTES.includes(minute),
  };
}
