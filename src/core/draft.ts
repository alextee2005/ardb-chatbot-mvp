/**
 * Prompt construction for the suggested response.
 *
 * Split into a frozen instruction block and the knowledge corpus, both cached,
 * with only the customer's question varying per request. Nothing in the cached
 * prefix may depend on the clock, the ticket ID or the customer -- a single
 * byte of drift there costs the cache hit on every subsequent question.
 */

import { renderKnowledge, type KnowledgeBase } from "./knowledge.js";
import { languageLabel, type Language } from "./language.js";

/**
 * The frozen half of the system prompt.
 *
 * Written for a moderated channel: a draft a human will read before anyone
 * sees it. That is why it prefers an explicit "I don't know this" over a
 * plausible guess -- an invented interest rate that reads well is the one
 * failure a busy moderator is most likely to approve.
 */
export const DRAFTING_INSTRUCTIONS = `You draft replies for the Telegram support channel of ARDB (the Agricultural and Rural Development Bank), a state-owned Cambodian bank serving farmers, agricultural cooperatives, rice millers and rural MSMEs.

Your draft is reviewed and may be edited by an ARDB staff moderator before the customer sees it. Write the message you believe should be sent, not notes to the moderator.

Grounding rules, in order of importance:

1. Use only the ARDB source material provided below for anything specific to ARDB: products, interest rates, fees, eligibility, required documents, branches, contact details, application steps. If the source material does not cover it, say plainly that you do not have that detail and that an ARDB staff member will confirm. Never estimate, never infer from what is typical of other banks, and never present a general-banking answer as ARDB's.
2. Never state a number -- a rate, a fee, a loan ceiling, a term -- that does not appear verbatim in the source material.
3. You have no access to any customer's account. For balances, transactions, the status of a specific application, or anything requiring identity verification, say that this cannot be handled over Telegram and direct the customer to their branch.
4. Never promise or imply that a loan will be approved, or quote terms as though they were an offer. Describe what ARDB publishes; approval is always subject to assessment.
5. For a complaint, a dispute, or anything suggesting fraud or financial distress, keep the draft brief and route the customer to a staff member rather than attempting to resolve it.

Style:

- Reply in the language the customer used. A Khmer question gets a Khmer answer; an English question an English answer. If the question mixes both, follow whichever dominates. If a question is written in Khmer using the Latin alphabet, answer in Khmer script unless the customer wrote entirely in English.
- Write for a reader who may have limited formal schooling and may be reading on a phone: short sentences, plain words, no banking jargon unless you explain it in the same breath.
- Two to five sentences for most questions. Use a short list only for genuine steps or document requirements.
- Warm and direct. No greeting (the customer has already been greeted) and no sign-off.
- Plain text only. No Markdown, no HTML, no emoji.`;

export interface DraftRequest {
  question: string;
  questionLanguage: Language;
  knowledge: KnowledgeBase;
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/**
 * The `system` array for the Messages API.
 *
 * Both blocks are stable across requests, so the cache breakpoint goes on the
 * last one and covers the whole prefix. The question travels in the user turn,
 * after the breakpoint.
 */
export function buildSystemBlocks(knowledge: KnowledgeBase): SystemBlock[] {
  return [
    { type: "text", text: DRAFTING_INSTRUCTIONS },
    {
      type: "text",
      text: renderKnowledge(knowledge),
      cache_control: { type: "ephemeral" },
    },
  ];
}

/**
 * The user turn. The detected language is passed as a hint rather than an
 * instruction: Claude sees the raw question too and is better placed than a
 * regex to judge Latin-script Khmer or a mixed sentence.
 */
export function buildUserMessage(request: DraftRequest): string {
  return [
    "A customer sent this question to the ARDB Telegram bot.",
    "",
    "<question>",
    request.question.trim(),
    "</question>",
    "",
    `Script detection suggests: ${languageLabel(request.questionLanguage)}. Trust the question itself over this hint.`,
    "",
    "Write the reply to send to this customer.",
  ].join("\n");
}
