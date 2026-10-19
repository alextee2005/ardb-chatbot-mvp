/**
 * Claude adapter: one question in, one suggested response out.
 *
 * Model notes, since they are easy to get wrong on Claude Opus 5.5:
 * thinking is always on and cannot be disabled -- `thinking: {type:
 * "disabled"}` and any `budget_tokens` are both rejected with a 400. Depth is
 * controlled only by `output_config.effort`, whose default on this model is
 * `medium`; we set it explicitly. Server-side fallbacks are opted into so a
 * safety decline is retried on another model inside the same call instead of
 * leaving the moderator with an empty card.
 */

import Anthropic from "@anthropic-ai/sdk";

import { buildSystemBlocks, buildUserMessage, type DraftRequest } from "../core/draft.js";

export type DraftResult =
  | { ok: true; text: string; cacheRead: number; cacheWrite: number }
  | { ok: false; error: string };

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Generous enough for adaptive thinking plus a short reply. Thinking tokens
 * count against this, so a value sized only for the visible answer would
 * truncate the draft mid-sentence.
 */
const MAX_TOKENS = 4000;

/**
 * Models that accept `fallbacks: "default"` -- the server re-running a
 * declined request on another model inside the same call.
 *
 * An allowlist rather than a denylist, because omitting the parameter is
 * always safe and sending it where it is unsupported is not: Haiku 5.5 has no
 * server-side fallback at all (a declined request stays declined), and a model
 * that rejects the parameter outright fails the whole request. A model missing
 * from this list loses a retry it never had; a model wrongly added to it loses
 * every draft.
 */
const FALLBACK_CAPABLE = /^claude-(fable-5|mythos-5|opus-5|sonnet-5-5)/;

export function supportsServerSideFallback(model: string): boolean {
  return FALLBACK_CAPABLE.test(model);
}

export async function draftResponse(
  config: ClaudeConfig,
  request: DraftRequest,
): Promise<DraftResult> {
  const client = new Anthropic({ apiKey: config.apiKey });

  try {
    // Routes by refusal category, so there is no fallback model list to keep
    // current as models come and go -- but only where the model supports it.
    const fallbacks = supportsServerSideFallback(config.model)
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
      : {};

    const response = await client.beta.messages.create({
      model: config.model,
      max_tokens: MAX_TOKENS,
      output_config: { effort: config.effort },
      ...fallbacks,
      system: buildSystemBlocks(request.knowledge),
      messages: [{ role: "user", content: buildUserMessage(request) }],
    });

    // Check before reading content: a refusal returns HTTP 200 with no usable
    // text, and the fallback model can itself decline.
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unspecified";
      return {
        ok: false,
        error: `Claude declined to answer this question (category: ${category}).`,
      };
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    if (!text) {
      return { ok: false, error: "Claude returned an empty draft." };
    }

    if (response.stop_reason === "max_tokens") {
      return {
        ok: false,
        error: "Claude's draft was cut off before it finished. Write the answer manually.",
      };
    }

    return {
      ok: true,
      text,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * How much of the API's own message to carry through.
 *
 * Enough to name a rejected field and its constraint, which is the whole
 * reason for quoting it, but bounded: the card is one Telegram message with a
 * hard 4096-character limit shared with the question, and a validation error
 * listing every union variant can run to thousands of characters.
 */
const MAX_API_MESSAGE_CHARS = 400;

/**
 * The API's own explanation of a rejection.
 *
 * A status and an error type alone cannot be acted on: every malformed
 * request is a 400 `invalid_request_error`, whether the cause is an
 * unsupported parameter, a blank content block or an over-long prompt. The
 * body says which, and dropping it costs a redeploy per hypothesis.
 *
 * Only the API's description of the request is quoted. It describes field
 * names and constraints, not the customer's question -- and the card it lands
 * on already shows that question to the same moderators.
 */
function apiMessage(error: InstanceType<typeof Anthropic.APIError>): string {
  const body: unknown = error.error;
  const detail =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { message?: unknown } }).error?.message
      : undefined;

  // `error.error` is the parsed body and is absent when the response was not
  // JSON (a gateway's HTML error page, say); `error.message` is the SDK's
  // composed string and is always present, so it is the fallback.
  const text = typeof detail === "string" && detail.trim() ? detail : error.message;
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > MAX_API_MESSAGE_CHARS
    ? `${trimmed.slice(0, MAX_API_MESSAGE_CHARS - 1)}\u2026`
    : trimmed;
}

/**
 * Specific before general: a rate limit and a bad API key need different
 * responses from whoever is on call, and collapsing them into one message
 * loses that.
 */
function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Claude rejected the API key. Check the ANTHROPIC_API_KEY secret.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Claude is rate limiting the bot. The question is queued but undrafted.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Claude API.";
  }
  if (error instanceof Anthropic.APIError) {
    // An exhausted balance arrives as a 400 invalid_request_error, not the 402
    // its meaning suggests, so it is indistinguishable from a malformed
    // request by status and type alone. It is also the one 400 that is not a
    // bug: nothing in this repo can fix it and no redeploy will help, so it
    // names the remedy instead of inviting someone to debug the request.
    if (error.status === 400 && /credit balance is too low/i.test(apiMessage(error))) {
      return (
        "The Anthropic account funding this bot is out of credits, so Claude " +
        "could not draft a reply. Top it up under Plans & Billing, or switch " +
        "DRAFT_PROVIDER to \"workers-ai\" (no credential, no cost) or \"none\" " +
        "for moderator-written replies."
      );
    }

    // The request ID is what Anthropic support asks for first.
    const reference = error.requestID ? ` [${error.requestID}]` : "";
    return (
      `Claude returned HTTP ${error.status ?? "unknown"} ` +
      `(${error.type ?? "unclassified"}): ${apiMessage(error)}${reference}`
    );
  }
  return error instanceof Error ? error.message : "Unknown error drafting a response.";
}
