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
 * Room for a full reply in Khmer, which tokenizes considerably worse than
 * English, *plus* reasoning tokens.
 *
 * The second part is what makes 2000 too small. On a reasoning model the
 * hidden reasoning is drawn from this same budget, so a value sized for the
 * answer alone can be spent entirely on thinking -- the model stops with
 * finish_reason "length" having produced no visible text at all, which
 * reaches the moderator as a draft that is simply missing.
 */
const MAX_TOKENS = 4000;

/**
 * Models whose reasoning cannot be switched off, only turned down.
 *
 * gpt-oss reasons on every request and defaults to "medium" effort. Left
 * alone on a ~20,000-token prompt it can think its way through the whole
 * output budget before writing a word of the answer.
 */
const REASONING_MODELS = /gpt-oss/;

/**
 * The three output shapes Workers AI returns, because WORKERS_AI_MODEL is
 * configuration and different model families answer differently:
 *
 * - `response`: the plain text-generation shape (Llama, Mistral, Qwen)
 * - `choices[]`: OpenAI chat completions (gpt-oss)
 * - `output_text` / `output[]`: OpenAI responses (gpt-oss, the other half of
 *   its input union)
 *
 * Reading only `response` is what made gpt-oss report an empty draft on every
 * question: it never sets that field, so a perfectly good answer sitting in
 * `choices[0].message.content` was discarded.
 */
interface WorkersAiResponse {
  response?: string;
  output_text?: string;
  output?: { content?: { text?: string; type?: string }[] }[];
  choices?: {
    message?: { content?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The reply text, from whichever shape this model used. */
function extractText(response: WorkersAiResponse): string {
  const candidates = [
    response.response,
    response.choices?.[0]?.message?.content ?? undefined,
    response.output_text,
    // The responses shape nests content items, and a reasoning model puts its
    // reasoning in there too -- so take text items only, in order.
    response.output
      ?.flatMap((item) => item.content ?? [])
      .filter((part) => part.type === undefined || part.type.includes("text"))
      .map((part) => part.text ?? "")
      .join(""),
  ];

  for (const candidate of candidates) {
    const text = candidate?.trim();
    if (text) return text;
  }
  return "";
}

export async function draftWithWorkersAi(
  config: WorkersAiConfig,
  request: DraftRequest,
): Promise<DraftResult> {
  try {
    // The model is configuration, not a literal, so it cannot be checked
    // against the generated union of model names. The cast is confined to this
    // one line; an unknown name fails at runtime with Cloudflare's own error,
    // which `describeError` passes through to the moderator's card.
    const inputs: Record<string, unknown> = {
      messages: [
        { role: "system", content: buildSystemPrompt(request.knowledge) },
        { role: "user", content: buildUserMessage(request) },
      ],
      max_tokens: MAX_TOKENS,
    };
    if (REASONING_MODELS.test(config.model)) {
      inputs.reasoning_effort = "low";
    }

    const response = (await config.binding.run(
      config.model as keyof AiModels,
      inputs as never,
    )) as WorkersAiResponse;

    const text = extractText(response);
    if (!text) {
      // Distinguish the two reasons a reply can be missing, because they need
      // different fixes: a budget spent on reasoning wants a larger
      // max_tokens or lower effort, while anything else is a model whose
      // output shape this adapter does not yet read.
      if (response.choices?.[0]?.finish_reason === "length") {
        return {
          ok: false,
          error:
            "The model used its whole output budget before writing an answer " +
            "-- on a reasoning model, thinking is drawn from the same budget. " +
            "Raise MAX_TOKENS or set a smaller WORKERS_AI_MODEL.",
        };
      }
      return {
        ok: false,
        error:
          "Workers AI returned no text in any shape this adapter reads " +
          `(keys: ${Object.keys(response).join(", ") || "none"}).`,
      };
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
