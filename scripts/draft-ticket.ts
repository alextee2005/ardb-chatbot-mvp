/**
 * Draft one ticket from GitHub Actions.
 *
 * Woken by `repository_dispatch` carrying only a ticket ID. Reads the ticket
 * from Postgres, asks Claude for a suggested answer, writes it back and
 * refreshes the moderator card -- the same `draftAndUpdateCard` the Worker
 * calls inline, so the card is identical whichever runtime produced it.
 *
 * Bundled with esbuild and run under Node; nothing it imports is
 * Cloudflare-specific, which is what makes two runtimes possible.
 *
 * Environment:
 *   TICKET_ID, DATABASE_URL, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN,
 *   MODERATOR_CHAT_ID, and optionally CLAUDE_MODEL / CLAUDE_EFFORT.
 */


import knowledgeJson from "../knowledge/corpus/ardb-corpus.json" with { type: "json" };

import { draftResponse } from "../src/adapters/claude.js";
import { Store } from "../src/adapters/store.js";
import { TelegramClient } from "../src/adapters/telegram.js";
import type { KnowledgeBase } from "../src/core/knowledge.js";
import { isTerminal } from "../src/core/tickets.js";
import { draftAndUpdateCard } from "../src/handlers/drafting.js";
import { env, exit, required, requiredInt } from "./lib/env.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const ticketId = requiredInt("TICKET_ID", { positive: true });
const databaseUrl = required("DATABASE_URL");
const anthropicApiKey = required("ANTHROPIC_API_KEY");
const telegramToken = required("TELEGRAM_BOT_TOKEN");

const moderatorChatId = requiredInt("MODERATOR_CHAT_ID");

const effort = env.CLAUDE_EFFORT?.trim() || "low";
if (!(EFFORTS as readonly string[]).includes(effort)) {
  console.error(`CLAUDE_EFFORT must be one of ${EFFORTS.join(", ")}, got "${effort}".`);
  exit(2);
}

const knowledge = knowledgeJson as KnowledgeBase;

const store = new Store(databaseUrl);
const ticket = await store.getTicket(ticketId);

if (!ticket) {
  // Not an error worth failing a run over: a ticket can be gone legitimately,
  // and a red workflow would mean someone investigating nothing.
  console.log(`Ticket ${ticketId} no longer exists. Nothing to draft.`);
  exit(0);
}

if (isTerminal(ticket.status)) {
  // A moderator answered before the runner started. Writing a draft now would
  // edit a card that has already been resolved.
  console.log(`Ticket ${ticketId} is already ${ticket.status}. Leaving it alone.`);
  exit(0);
}

if (ticket.draft) {
  console.log(`Ticket ${ticketId} already has a draft. Not overwriting it.`);
  exit(0);
}

console.log(
  `Drafting ticket ${ticketId} (${ticket.questionLanguage}, ${ticket.question.length} chars) ` +
    `against corpus ${knowledge.version} with ${env.CLAUDE_MODEL?.trim() || "claude-haiku-5-5"}.`,
);

await draftAndUpdateCard(
  {
    telegram: new TelegramClient(telegramToken),
    store,
    knowledge,
    moderatorChatId,
    draft: (request) =>
      draftResponse(
        {
          apiKey: anthropicApiKey,
          model: env.CLAUDE_MODEL?.trim() || "claude-haiku-5-5",
          effort: effort as (typeof EFFORTS)[number],
        },
        request,
      ),
  },
  ticket,
);

// The question text is never printed -- not here, and not in the dispatch
// payload. It stays in Postgres, where the moderator card is the only place
// it is meant to be read.
console.log(`Ticket ${ticketId} done. The moderator card has been refreshed.`);
