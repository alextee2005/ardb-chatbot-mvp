/**
 * Which sweeps are due on a given minute.
 *
 * The Worker has one Cron Trigger -- `* * * * *` -- and decides here what
 * that minute is for. It used to have three triggers and match `event.cron`
 * against string literals, which failed twice in one afternoon:
 *
 *   - Cloudflare numbers the day-of-week field 1 = Sunday, not 0 = Sunday as
 *     crontab does, so "17 3 * * 0" was rejected by the schedules API *after*
 *     the Worker had already uploaded.
 *   - The Workers Free plan allows 5 cron triggers per account, and three of
 *     them did not fit alongside what the account already had.
 *
 * One trigger sidesteps both: there is no cron syntax to get wrong beyond
 * `* * * * *`, nothing to keep in step between wrangler.jsonc and the Worker,
 * and four of the account's five slots stay free. The cost is that the
 * schedule lives in code -- which is testable, where a cron string was not.
 *
 * Times are UTC throughout, because that is what Cloudflare invokes on and
 * what `Date.getUTC*` reports. Taking `now` as an argument rather than
 * reading the clock is what makes every boundary below assertable.
 */

export interface ScheduledWork {
  /** Follow-ups and satisfaction surveys. Every minute. */
  engagement: boolean;
  /** Nudging moderators about unanswered tickets. Every five minutes. */
  sla: boolean;
  /** Archiving and purging closed conversations. Weekly. */
  archive: boolean;
}

/** Minute past the hour for the weekly archive, and its retry. */
const ARCHIVE_MINUTES = [17, 47];
/** UTC hour for the weekly archive. */
const ARCHIVE_HOUR = 3;
/** `Date.getUTCDay()` is 0 for Sunday -- the JavaScript convention, not Cloudflare's. */
const ARCHIVE_DAY = 0;

export function scheduledWork(now: Date): ScheduledWork {
  const minute = now.getUTCMinutes();

  return {
    // The follow-up is due 30 minutes after the last activity and the survey
    // the moment a conversation closes. Both want a short, regular sweep so
    // they arrive when they are meant to rather than up to five minutes late.
    engagement: true,

    // Unchanged from the old */5 schedule. Deliberately not every minute: it
    // is the expensive sweep and its thresholds start at ten minutes.
    sla: minute % 5 === 0,

    // Sunday 03:17 UTC, with a retry at 03:47. Two attempts rather than one
    // because a single missed invocation would skip the week entirely, and
    // the archive is idempotent -- a second run either finds nothing to do or
    // continues working through a backlog a batch at a time.
    //
    // An odd minute rather than the hour: schedules on the hour are the most
    // contended, and this one only gets 52 chances a year.
    archive:
      now.getUTCDay() === ARCHIVE_DAY &&
      now.getUTCHours() === ARCHIVE_HOUR &&
      ARCHIVE_MINUTES.includes(minute),
  };
}
