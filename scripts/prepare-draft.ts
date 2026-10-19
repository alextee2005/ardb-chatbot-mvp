/**
 * Step 1 of the subscription drafting route: render the prompt to files.
 *
 * Reads the ticket from Postgres and writes the system prompt and the
 * question to separate files for the `claude -p` step that follows. The
 * question goes to a file rather than an argument or a log line on purpose:
 * arguments appear in process listings and Actions logs are readable by
 * anyone with repository access and retained for weeks. A customer's enquiry
 * belongs in Postgres and on the moderator card, nowhere else.
 *
 * Writes `skip=true` to GITHUB_OUTPUT when there is nothing to draft, so the
 * CLI step and the delivery step both no-op instead of failing.
 *
 * Environment: TICKET_ID, DATABASE_URL, PROMPT_DIR, and GITHUB_OUTPUT.
 */

import { writeFileSync, appendFileSync } from "node:fs";

import knowledgeJson from "../knowledge/corpus/ardb-corpus.json" with { type: "json" };

import { Store } from "../src/adapters/store.js";
import { buildSystemPrompt, buildUserMessage } from "../src/core/draft.js";
import type { KnowledgeBase } from "../src/core/knowledge.js";
import { isTerminal } from "../src/core/tickets.js";
import { env, exit, required, requiredInt } from "./lib/env.js";

const ticketId = requiredInt("TICKET_ID", { positive: true });
const databaseUrl = required("DATABASE_URL");
const promptDir = required("PROMPT_DIR");

/** Tell the later steps to stand down, then exit cleanly. */
function skip(reason: string): never {
  console.log(reason);
  const output = env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, "skip=true\n");
  exit(0);
}

const knowledge = knowledgeJson as unknown as KnowledgeBase;
const store = new Store(databaseUrl);
const ticket = await store.getTicket(ticketId);

if (!ticket) {
  // A ticket can be gone legitimately, and a red workflow would send someone
  // to investigate nothing.
  skip(`Ticket ${ticketId} no longer exists. Nothing to draft.`);
}

if (isTerminal(ticket.status)) {
  // A moderator answered before the runner started. Drafting now would edit
  // a card that has already been resolved.
  skip(`Ticket ${ticketId} is already ${ticket.status}. Leaving it alone.`);
}

if (ticket.draft) {
  skip(`Ticket ${ticketId} already has a draft. Not overwriting it.`);
}

writeFileSync(`${promptDir}/system.txt`, buildSystemPrompt(knowledge), "utf8");
writeFileSync(
  `${promptDir}/question.txt`,
  buildUserMessage({
    question: ticket.question,
    questionLanguage: ticket.questionLanguage,
    knowledge,
  }),
  "utf8",
);

console.log(
  `Prepared ticket ${ticketId} (${ticket.questionLanguage}, ` +
    `${ticket.question.length} chars) against corpus ${knowledge.version}.`,
);
