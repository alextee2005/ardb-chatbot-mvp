/**
 * Step 3 of the subscription drafting route: store the draft, refresh the card.
 *
 * Reads what `claude -p` printed, turns it into the same `DraftResult` every
 * other provider returns, and hands it to the same `draftAndUpdateCard` the
 * Worker calls -- so the moderator card is identical whichever route produced
 * it, and a failure here looks like a failure anywhere else.
 *
 * Runs even when the CLI step failed (`if: always()`), because a card left
 * showing "drafting..." forever is worse than one showing why there is no
 * draft. With no result file at all, the reason is reported as the failure.
 *
 * The draft text is never printed. It goes to Postgres and to the card.
 *
 * Environment: TICKET_ID, DATABASE_URL, TELEGRAM_BOT_TOKEN,
 * MODERATOR_CHAT_ID, PROMPT_DIR, and optionally CLI_OUTCOME.
 */

import { existsSync, readFileSync } from "node:fs";

import knowledgeJson from "../knowledge/corpus/ardb-corpus.json" with { type: "json" };

import type { DraftResult } from "../src/adapters/claude.js";
import { parseCliResult } from "../src/adapters/claude-cli.js";
import { Store } from "../src/adapters/store.js";
import { TelegramClient } from "../src/adapters/telegram.js";
import type { KnowledgeBase } from "../src/core/knowledge.js";
import { isTerminal } from "../src/core/tickets.js";
import { draftAndUpdateCard } from "../src/handlers/drafting.js";
import { env, exit, required, requiredInt } from "./lib/env.js";

const ticketId = requiredInt("TICKET_ID", { positive: true });
const databaseUrl = required("DATABASE_URL");
const telegramToken = required("TELEGRAM_BOT_TOKEN");
const moderatorChatId = requiredInt("MODERATOR_CHAT_ID");
const promptDir = required("PROMPT_DIR");

const resultPath = `${promptDir}/result.json`;

/**
 * What to tell the moderator, from whatever the CLI left behind.
 *
 * A missing file means the step before this one did not get as far as
 * printing: the log says why, and the card says to answer by hand.
 */
const result: DraftResult = existsSync(resultPath)
  ? parseCliResult(readFileSync(resultPath, "utf8"))
  : {
      ok: false,
      error:
        "The drafting step did not produce a result" +
        (env.CLI_OUTCOME ? ` (it ended as "${env.CLI_OUTCOME}")` : "") +
        ". Tap Edit and write the reply.",
    };

const store = new Store(databaseUrl);
const ticket = await store.getTicket(ticketId);

if (!ticket) {
  console.log(`Ticket ${ticketId} no longer exists. Nothing to update.`);
  exit(0);
}

if (isTerminal(ticket.status)) {
  // Answered by hand while the draft was being written. The card is resolved
  // and must not be edited back into a queued-looking state.
  console.log(`Ticket ${ticketId} is already ${ticket.status}. Discarding the draft.`);
  exit(0);
}

await draftAndUpdateCard(
  {
    telegram: new TelegramClient(telegramToken),
    store,
    knowledge: knowledgeJson as unknown as KnowledgeBase,
    moderatorChatId,
    // Already drafted; this hands the finished result to the shared card
    // logic rather than asking a provider for another one.
    draft: async () => result,
  },
  ticket,
);

console.log(
  result.ok
    ? `Ticket ${ticketId} drafted. The moderator card has been refreshed.`
    : `Ticket ${ticketId} not drafted; the card explains why and still has Edit.`,
);

// A failed draft is not a failed run: the question is not lost and a
// moderator can answer it. The log line above and the card carry the reason.
