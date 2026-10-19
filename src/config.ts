/**
 * Environment binding and validation.
 *
 * Validated once per request so a missing secret surfaces as one clear log
 * line at the edge, rather than as an undefined threaded three calls deep.
 */

import { DEFAULT_FOLLOWUP_MINUTES, DEFAULT_IDLE_MINUTES } from "./core/conversations.js";
import { DEFAULT_SLA_POLICY, type SlaPolicy } from "./core/sla.js";

/** Who writes the suggested answer, if anyone. */
export type DraftProvider = "claude" | "workers-ai" | "github" | "none";

const PROVIDERS = ["claude", "workers-ai", "github", "none"] as const;

export interface Env {
  /**
   * Cloudflare's own inference, bound in wrangler.jsonc. Present whenever the
   * binding is configured, with no credential of any kind.
   */
  AI?: Ai;

  // Secrets -- `wrangler secret put <NAME>`.
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  MODERATOR_CHAT_ID: string;
  DATABASE_URL: string;
  /**
   * Only for DRAFT_PROVIDER "github": a fine-grained token with Contents:
   * write on this repository and nothing else. It can trigger workflows,
   * which is why its scope matters more than the Claude key's.
   */
  GITHUB_DISPATCH_TOKEN?: string;
  /**
   * Optional. Without it the bot runs moderator-only: a question still files
   * a ticket and still reaches the group, but with no suggested answer for a
   * moderator to edit. See `drafting` in Config.
   */
  ANTHROPIC_API_KEY?: string;

  // Plain vars from wrangler.jsonc.
  DRAFT_PROVIDER?: string;
  CLAUDE_MODEL?: string;
  CLAUDE_EFFORT?: string;
  WORKERS_AI_MODEL?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_DISPATCH_EVENT?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  LOG_LEVEL?: string;
  CONVERSATION_IDLE_MINUTES?: string;
  FOLLOWUP_MINUTES?: string;
  ARCHIVE_AFTER_DAYS?: string;
  ARCHIVE_BATCH_SIZE?: string;
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
  /**
   * Cloudflare's inference binding, carried here alongside the API key so
   * that choosing a provider needs only Config and never the raw Env -- which
   * keeps every other secret out of reach of the code that drafts.
   */
  ai: Ai | null;
  databaseUrl: string;
  /**
   * The provider that can actually run, which is not always the one asked
   * for: "claude" with no key resolves to "none" rather than failing every
   * webhook call. `/health` reports this value, not the requested one.
   */
  draftProvider: DraftProvider;
  claudeModel: string;
  claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
  workersAiModel: string;
  githubDispatch: { token: string; repository: string; eventType: string } | null;
  rateLimitPerMinute: number;
  /** Idle minutes after which a conversation is considered ended. */
  conversationIdleMinutes: number;
  /** Minutes after the last answer before asking "anything else?". */
  followupMinutes: number;
  /** How long a closed conversation stays in the live tables. */
  archiveAfterDays: number;
  /** Conversations moved per weekly run, so one run stays inside the CPU limit. */
  archiveBatchSize: number;
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

  const requested = env.DRAFT_PROVIDER ?? "workers-ai";
  if (!(PROVIDERS as readonly string[]).includes(requested)) {
    throw new ConfigError(
      `DRAFT_PROVIDER must be one of ${PROVIDERS.join(", ")}, got "${requested}"`,
    );
  }

  // Resolve what can run, rather than what was asked for. A provider that
  // cannot run degrades to moderator-only: the queue keeps working and a
  // person writes the answer. Only a typo in the name above is fatal, because
  // that is a mistake rather than a missing optional dependency.
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim() ? env.ANTHROPIC_API_KEY : null;
  let draftProvider: DraftProvider = requested as DraftProvider;
  if (draftProvider === "claude" && !anthropicApiKey) draftProvider = "none";
  if (draftProvider === "workers-ai" && !env.AI) draftProvider = "none";

  // The dispatch needs both halves: a token to authenticate and a repository
  // to aim at. GITHUB_REPOSITORY has no safe default -- guessing a repository
  // name would send a customer's ticket ID to someone else's workflow.
  const dispatchToken = env.GITHUB_DISPATCH_TOKEN?.trim() ? env.GITHUB_DISPATCH_TOKEN : null;
  const dispatchRepo = env.GITHUB_REPOSITORY?.trim() ? env.GITHUB_REPOSITORY.trim() : null;
  const githubDispatch =
    dispatchToken && dispatchRepo
      ? {
          token: dispatchToken,
          repository: dispatchRepo,
          eventType: env.GITHUB_DISPATCH_EVENT?.trim() || "draft-ticket",
        }
      : null;
  if (draftProvider === "github" && !githubDispatch) draftProvider = "none";

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
    anthropicApiKey,
    ai: env.AI ?? null,
    databaseUrl: env.DATABASE_URL,
    // Matches the var in wrangler.jsonc. A cheap default rather than an
    // expensive one: a missing var should not quietly cost 40x more per
    // question than the deployment intends.
    draftProvider,
    claudeModel: env.CLAUDE_MODEL ?? "claude-haiku-5-5",
    // Confirmed 128K context window, which matters because the whole corpus
    // (~20,000 tokens) is sent with every question and Workers AI has no
    // prompt cache to put it behind.
    workersAiModel: env.WORKERS_AI_MODEL ?? "@cf/openai/gpt-oss-20b",
    githubDispatch,
    claudeEffort: effort as Config["claudeEffort"],
    rateLimitPerMinute: positiveInt(env.RATE_LIMIT_PER_MINUTE, 3),
    conversationIdleMinutes: positiveInt(
      env.CONVERSATION_IDLE_MINUTES,
      DEFAULT_IDLE_MINUTES,
    ),
    followupMinutes: positiveInt(env.FOLLOWUP_MINUTES, DEFAULT_FOLLOWUP_MINUTES),
    archiveAfterDays: positiveInt(env.ARCHIVE_AFTER_DAYS, 7),
    archiveBatchSize: positiveInt(env.ARCHIVE_BATCH_SIZE, 200),
    sla,
  };
}
