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


/**
 * Declared rather than imported from `node:process`.
 *
 * This project's tsconfig targets Workers and carries no @types/node, and
 * adding them to typecheck one Node script would put Node's globals in scope
 * for src/ too -- where they do not exist at runtime. Typing `exit` as
 * `never` also lets the compiler see that the guards below are terminal.
 */
declare const process: {
  env: Record<string, string | undefined>;
  exit: (code: number) => never;
};
const { env } = process;
// The annotation is load-bearing: TypeScript treats a call as terminal only
// when the callee is a name with an explicitly declared never return type,
// so without it every guard below leaves `ticket` possibly null.
const exit: (code: number) => never = process.exit;

// Bundled in, exactly as src/worker.ts imports it, so the drafting job and
// the Worker ground a draft in the same bytes. Reading it from disk at
// runtime would depend on where the bundle happens to sit.
import knowledgeJson from "../knowledge/corpus/ardb-corpus.json" with { type: "json" };

import { draftResponse } from "../src/adapters/claude.js";
import { Store } from "../src/adapters/store.js";
import { TelegramClient } from "../src/adapters/telegram.js";
import type { KnowledgeBase } from "../src/core/knowledge.js";
import { isTerminal } from "../src/core/tickets.js";
import { draftAndUpdateCard } from "../src/handlers/drafting.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function required(name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    console.error(`${name} is not set.`);
    exit(2);
  }
  return value;
}

const ticketId = Number.parseInt(required("TICKET_ID"), 10);
if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
  console.error(`TICKET_ID must be a positive integer, got "${env.TICKET_ID}".`);
  exit(2);
}

const databaseUrl = required("DATABASE_URL");
const anthropicApiKey = required("ANTHROPIC_API_KEY");
const telegramToken = required("TELEGRAM_BOT_TOKEN");

const moderatorChatId = Number.parseInt(required("MODERATOR_CHAT_ID"), 10);
if (!Number.isSafeInteger(moderatorChatId)) {
  console.error("MODERATOR_CHAT_ID must be an integer.");
  exit(2);
}

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
