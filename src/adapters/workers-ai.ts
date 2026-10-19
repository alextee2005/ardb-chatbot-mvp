/**
 * Workers AI adapter: the same contract as the Claude adapter, no API key.
 *
 * Inference runs on Cloudflare's own infrastructure through the `AI` binding,
 * so there is no external credential and no second vendor to bill. The trade
 * is model quality, which the moderator review absorbs: nothing reaches a
 * customer unread.
 *
 * Two Workers AI specifics are load-bearing here.
 *
 * `max_tokens` defaults to 256, which truncates a draft mid-sentence. It is
 * set explicitly below.
 *
 * There is no prompt caching, so every question pays full price for the whole
 * corpus -- about 20,000 input tokens. That is why the cheap-per-input-token
 * models matter more here than on the Claude path, where the corpus sits
 * behind a cache breakpoint and costs a tenth as much after the first call.
 */

import { buildSystemPrompt, buildUserMessage, type DraftRequest } from "../core/draft.js";
import type { DraftResult } from "./claude.js";

export interface WorkersAiConfig {
  binding: Ai;
  model: string;
}

/**
 * Generous enough for a full reply in Khmer, which tokenizes considerably
 * worse than English -- the same answer can be two or three times the tokens.
 * Nowhere near the models' output ceilings, but a draft longer than this is a
 * sign the prompt has gone wrong rather than a reply worth sending.
 */
const MAX_TOKENS = 2000;

export async function draftWithWorkersAi(
  config: WorkersAiConfig,
  request: DraftRequest,
): Promise<DraftResult> {
  try {
    // The model is configuration, not a literal, so it cannot be checked
    // against the generated union of model names. The cast is confined to this
    // one line; an unknown name fails at runtime with Cloudflare's own error,
    // which `describeError` passes through to the moderator's card.
    const response = (await config.binding.run(config.model as keyof AiModels, {
      messages: [
        { role: "system", content: buildSystemPrompt(request.knowledge) },
        { role: "user", content: buildUserMessage(request) },
      ],
      max_tokens: MAX_TOKENS,
    } as never)) as { response?: string; usage?: { prompt_tokens: number; completion_tokens: number } };

    const text = response.response?.trim();
    if (!text) {
      return { ok: false, error: "Workers AI returned an empty draft." };
    }

    // Reported as cacheRead/cacheWrite 0 because Workers AI has no prompt
    // cache. The token counts travel in the log line instead, which is what
    // the daily neuron allowance is actually spent on.
    return { ok: true, text, cacheRead: 0, cacheWrite: 0 };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Workers AI reports failures as thrown errors with a message, not as typed
 * classes, so this reads the message. The three cases below are the ones a
 * moderator can act on, and each needs a different response: wait, shorten, or
 * fix the configuration.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // The free allowance is 10,000 neurons a day, reset at 00:00 UTC. Hitting it
  // is not a fault -- it is the plan working as sold -- so the message says
  // what to do rather than what broke.
  if (/neuron|quota|limit exceeded|too many requests|429/i.test(message)) {
    return (
      "Workers AI daily limit reached, so there is no suggested answer. " +
      "Tap Edit and write the reply. The allowance resets at 00:00 UTC."
    );
  }

  // The corpus is sent whole with every question, so a model with a smaller
  // context window than the corpus fails every single request. Naming the
  // cause saves a long hunt through a model that simply cannot hold it.
  if (/context|too long|maximum.*token|input.*length/i.test(message)) {
    return (
      "The question plus ARDB's source material is longer than this model's " +
      "context window. Set WORKERS_AI_MODEL to a model with a larger window."
    );
  }

  if (/no such model|not found|invalid model/i.test(message)) {
    return `Workers AI does not recognise the model "${message}". Check WORKERS_AI_MODEL.`;
  }

  return `Workers AI failed to draft a response: ${message}`;
}
