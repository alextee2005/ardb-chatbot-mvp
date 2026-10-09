/**
 * Environment binding and validation.
 *
 * Validated once per request so a missing secret surfaces as one clear log
 * line at the edge, rather than as an undefined threaded three calls deep.
 */

import { DEFAULT_SLA_POLICY, type SlaPolicy } from "./core/sla.js";

export interface Env {
  // Secrets -- `wrangler secret put <NAME>`.
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  MODERATOR_CHAT_ID: string;
  DATABASE_URL: string;
  /**
   * Optional. Without it the bot runs moderator-only: a question still files
   * a ticket and still reaches the group, but with no suggested answer for a
   * moderator to edit. See `drafting` in Config.
   */
  ANTHROPIC_API_KEY?: string;

  // Plain vars from wrangler.jsonc.
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  LOG_LEVEL?: string;
  SLA_NUDGE_AFTER_MINUTES?: string;
  SLA_NUDGE_REPEAT_MINUTES?: string;
  SLA_MAX_NUDGES?: string;
  SLA_WARN_CUSTOMER_AFTER_MINUTES?: string;
}

export interface Config {
  telegramToken: string;
  webhookSecret: string;
  moderatorChatId: number;
  /** Null when no key is configured; drafting is then skipped entirely. */
  anthropicApiKey: string | null;
  databaseUrl: string;
  claudeModel: string;
  claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
  rateLimitPerMinute: number;
  sla: SlaPolicy;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Falls back to the default when a var is absent, blank or not a positive integer. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export class ConfigError extends Error {}

export function loadConfig(env: Env): Config {
  const missing = (
    [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "MODERATOR_CHAT_ID",
      "DATABASE_URL",
    ] as const
  ).filter((key) => !env[key]);

  if (missing.length > 0) {
    throw new ConfigError(`Missing required secrets: ${missing.join(", ")}`);
  }

  // Group chat IDs are negative, so this cannot be a positive-only parse.
  const moderatorChatId = Number.parseInt(env.MODERATOR_CHAT_ID, 10);
  if (!Number.isSafeInteger(moderatorChatId)) {
    throw new ConfigError(
      `MODERATOR_CHAT_ID must be an integer, got "${env.MODERATOR_CHAT_ID}"`,
    );
  }

  const effort = env.CLAUDE_EFFORT ?? "low";
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new ConfigError(
      `CLAUDE_EFFORT must be one of ${EFFORTS.join(", ")}, got "${effort}"`,
    );
  }

  const sla: SlaPolicy = {
    nudgeAfterMinutes: positiveInt(
      env.SLA_NUDGE_AFTER_MINUTES,
      DEFAULT_SLA_POLICY.nudgeAfterMinutes,
    ),
    nudgeRepeatMinutes: positiveInt(
      env.SLA_NUDGE_REPEAT_MINUTES,
      DEFAULT_SLA_POLICY.nudgeRepeatMinutes,
    ),
    maxNudges: positiveInt(env.SLA_MAX_NUDGES, DEFAULT_SLA_POLICY.maxNudges),
    warnCustomerAfterMinutes: positiveInt(
      env.SLA_WARN_CUSTOMER_AFTER_MINUTES,
      DEFAULT_SLA_POLICY.warnCustomerAfterMinutes,
    ),
  };

  return {
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    moderatorChatId,
    // Deliberately not in the required list. The supervised queue -- ticket,
    // card, moderator writes the answer, bot delivers it -- is the part that
    // must work. Drafting is an accelerator on top of it, so a bot with no
    // Claude key should run with a human writing every answer rather than
    // refuse to start. An empty string counts as absent.
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() ? env.ANTHROPIC_API_KEY : null,
    databaseUrl: env.DATABASE_URL,
    // Matches the var in wrangler.jsonc. A cheap default rather than an
    // expensive one: a missing var should not quietly cost 40x more per
    // question than the deployment intends.
    claudeModel: env.CLAUDE_MODEL ?? "claude-haiku-5-5",
    claudeEffort: effort as Config["claudeEffort"],
    rateLimitPerMinute: positiveInt(env.RATE_LIMIT_PER_MINUTE, 3),
    sla,
  };
}
