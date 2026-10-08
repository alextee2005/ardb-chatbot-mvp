# ARDB Telegram Bot (MVP)

A supervised Telegram support bot for the **Agricultural and Rural Development
Bank** of Cambodia. Customers ask questions in Khmer or English; Claude drafts
a reply; an ARDB staff moderator approves, edits or rejects it; only then does
the customer see anything.

No answer ever reaches a customer without a human sending it.

## The two flows

### 1. Customer opens the bot

The customer taps **Start**. The bot replies with the greeting in Khmer and
English:

> សួស្តី! ខ្ញុំឈ្មោះ ARDB Bot។ តើខ្ញុំអាចជួយអ្វីអ្នកបាននៅថ្ងៃនេះ?
>
> — — —
>
> Hi, my name is ARDB Bot. How can I help you today?

### 2. Customer asks a question

```
Customer                 Worker                    Moderator group
   │                       │                             │
   ├── question ──────────►│                             │
   │◄── "please give me    │                             │
   │     some time…" ──────┤                             │
   │                       ├── ticket card (drafting) ──►│
   │                       │                             │
   │                       ├── Claude drafts ───────┐    │
   │                       │◄───────────────────────┘    │
   │                       ├── card + buttons ─────────►│
   │                       │                      ✅ / ✏️ / 🚫
   │                       │◄────────────────────────────┤
   │◄── final answer ──────┤                             │
   │                       ├── card marked answered ───►│
```

The customer is acknowledged immediately, in the language they wrote in. The
moderator group gets a card with the customer's identity, the question, the
language to answer in, and Claude's suggested response, under three buttons:

- **✅ Send as-is** — delivers the draft unchanged.
- **✏️ Edit** — the bot asks for a replacement with a force-reply; the
  moderator types the final answer and it goes to the customer.
- **🚫 Reject** — the customer is told to contact a branch. No AI text is sent.

A moderator can also just reply directly to a card with the final text, without
tapping anything.

## Setup

### 1. Telegram

In BotFather: `/newbot`, then **`/setprivacy` → Disable**. Without that last
step the bot cannot read moderator replies in the group, so ✏️ Edit silently
does nothing.

Then create a **private** group, add the bot, and send any message in it.

Store the token as a repository secret named `TELEGRAM_BOT_TOKEN`
(Settings → Secrets and variables → Actions) and run the **Verify bot**
workflow. It reports the bot's identity, its privacy setting, webhook state,
and the chat IDs it can see — use the negative group ID as
`MODERATOR_CHAT_ID`.

Locally instead:

```bash
pip install -r tools/requirements.txt
TELEGRAM_BOT_TOKEN='...' python tools/verify_bot.py
```

### 2. Database

Create a Neon project, then:

```bash
export DATABASE_URL='postgresql://…?sslmode=require'
npm run migrate
```

### 3. Knowledge base

**This is the step that decides whether the bot is useful.** The committed
`knowledge/ardb-knowledge.json` is an empty placeholder, and while it stays
empty Claude is instructed to say it has no ARDB-specific details — so drafts
will be honest and nearly useless.

Run the **Scrape knowledge base** workflow. It crawls www.ardb.com.kh and
opens a pull request with the result and a review checklist — deliberately a
pull request, not a direct commit, because an unreviewed knowledge file is how
a navigation blob or a wrong interest rate reaches a customer.

> **One repository setting.** `GITHUB_TOKEN` cannot open a pull request unless
> *Settings → Actions → General → Workflow permissions → Allow GitHub Actions
> to create and approve pull requests* is enabled, and it is off by default.
> Without it the workflow still scrapes and pushes the branch, then prints a
> one-click link to open the pull request yourself — the scrape is never lost
> to that setting.

Locally instead:

```bash
pip install -r tools/requirements.txt
python tools/scrape_knowledge.py --dry-run   # see what it would keep
python tools/scrape_knowledge.py             # write it
```

See `knowledge/README.md` for the format and for hand-written entries, which
survive a re-scrape and override a scraped page of the same ID.

### 4. Secrets and deploy

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in, for local `wrangler dev`

for name in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET MODERATOR_CHAT_ID \
            ANTHROPIC_API_KEY DATABASE_URL; do
  npx wrangler secret put "$name"
done

npm run check     # typecheck + tests
npm run deploy
```

### 5. Register the webhook

```bash
WORKER_URL=https://ardb-chatbot.<your-subdomain>.workers.dev \
TELEGRAM_WEBHOOK_SECRET='…' \
TELEGRAM_BOT_TOKEN='…' \
npm run set-webhook
```

Check it with `curl https://<worker>/health`, which reports the loaded
knowledge-base version and whether it is still the placeholder.

## Architecture

```
src/
├── worker.ts            Webhook: verify, dedupe, route, ack fast
├── config.ts            Secret binding and validation
├── core/                Pure logic — no Cloudflare, no Telegram, no network
│   ├── language.ts      Khmer/English script detection
│   ├── messages.ts      Every customer-facing string, bilingual
│   ├── knowledge.ts     Grounding corpus shape and rendering
│   ├── draft.ts         System prompt and cache breakpoint placement
│   ├── tickets.ts       Ticket lifecycle and moderator permissions
│   ├── sla.ts           When an unanswered ticket needs chasing
│   ├── callbacks.ts     Inline-button payload encoding
│   └── moderator-card.ts  Card rendering and keyboards
├── adapters/            The outside world, one file per dependency
│   ├── telegram.ts      Bot API
│   ├── claude.ts        Messages API
│   └── store.ts         Neon over HTTP
└── handlers/
    ├── customer.ts      /start and questions
    ├── moderator.ts     Button taps and edited answers
    └── sla.ts           The scheduled sweep over stalled tickets

tools/                   Python, run on GitHub Actions
├── verify_bot.py        Token, privacy setting, webhook, visible chat IDs
├── scrape_knowledge.py  Crawl -> knowledge file -> pull-request body
├── consolidate_knowledge.py  Khmer pages -> one normalized English corpus
├── ardb/
│   ├── knowledge.py     The schema contract with src/core/knowledge.ts
│   ├── scraper.py       Crawl filters and HTML extraction
│   ├── normalize.py     Khmer numerals and separators -> English notation
│   ├── consolidate.py   The restatement call and its figure-preservation guard
│   └── telegram.py      Read-only Bot API client
└── tests/               155 tests, including a crawl against a fixture site

.github/workflows/
├── ci.yml               Typecheck, both test suites, Worker bundle
├── verify-bot.yml        Manual bot verification
└── scrape-knowledge.yml  Manual or monthly re-scrape, opens a PR
```

`core/` imports nothing platform-specific, which is what makes a move off
Cloudflare a rewrite of `worker.ts` and the three adapters rather than of the
business logic. The 65 tests cover `core/` only, and need no mocks.

### Decisions worth knowing

**The webhook acknowledges Telegram before doing any work.** The question is
handled in `ctx.waitUntil`. Telegram retries a webhook it considers slow, and a
retry would file a second ticket for one question — so the fast `200` plus the
`processed_updates` dedupe table are two halves of one defence.

**Claude Opus 5.5 at `low` effort.** Thinking cannot be disabled on this model
and `budget_tokens` is rejected outright; `output_config.effort` is the only
control, and its default is `medium`, so it is set explicitly. Server-side
refusal fallbacks are enabled, so a safety decline is retried on another model
inside the same call rather than leaving a moderator with an empty card. Change
the model in `wrangler.jsonc` without touching code.

**The whole knowledge base is sent with every question**, behind a prompt-cache
breakpoint, rather than retrieved. There is no retrieval step to tune and no
chance of the relevant page being the one retrieval missed. `renderKnowledge`
is byte-stable so the cache actually hits; revisit only if the corpus outgrows
the context window.

**Claiming is atomic in SQL.** Several moderators see the same card and may tap
at the same instant. The guard is in the `WHERE` clause of a single `UPDATE`, so
exactly one can win, and the ticket is resolved *before* the customer message
is sent — which is what stops two moderators delivering two answers.

**Moderator authorization is positional.** Only updates originating in the
configured group reach the moderator handlers, so anyone who can see a card is
a moderator by construction. There is no allowlist to drift out of sync with
the group's membership — add and remove staff in Telegram.

### Consolidation into one English corpus

The scraped pages are Khmer. A second pass restates each one as English
reference material, so the corpus the Worker sends is one language and one
representation:

```bash
ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py
ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py --dry-run
ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py --only faq --force
```

The **Scrape knowledge base** workflow runs this automatically (uncheck
*consolidate* to skip it); it needs an `ANTHROPIC_API_KEY` repository secret.

> **If the key is organization-level rather than workspace-scoped**, it will
> authenticate and then every request fails with *"This API key is not scoped
> to a workspace"*. Two ways out, and the first is simpler:
>
> 1. Create an API key **scoped to a workspace** in the Console. A scoped key
>    needs no header and no extra secret.
> 2. Or add an `ANTHROPIC_WORKSPACE_ID` secret. It must be the workspace
>    **ID**, not its name — `wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ`, found in the
>    Console under Settings → Workspaces in the ID column. A name is rejected
>    locally with that explanation rather than becoming a 400 from the API.

A single minimal request runs before the loop. Any credential, billing, model
or workspace problem surfaces there, in one second, carrying the API's own
message — rather than 33 entries in, reported as a corpus problem.

This deliberately puts a model between what ARDB publishes and what a customer
is told, which is a real risk: a mistranslated rate reads exactly like a
correct one, so a moderator approving by eye cannot catch it. Four things hold
it down.

1. **Figures never reach the model in Khmer form.** `tools/ardb/normalize.py`
   converts Khmer numerals and ARDB's separator convention first, so the step
   most likely to produce a wrong number has no model in it. That conversion
   is pure and has 36 tests of its own.
2. **Every entry is checked for figure preservation** against its source. A
   figure the source states and the output never mentions, or one the output
   states from nowhere, fails that entry. Compared as sets, not counts: a
   rate table lists each figure once per currency column, and the faithful
   English restatement says it once, so counting occurrences would fail good
   translations — and failing good output trains people to ignore the check.
3. **A failed entry keeps its Khmer text** rather than shipping an unverified
   rewrite, and is named in the pull request for review.
4. **The Khmer source is retained** as `sourceText` on every consolidated
   entry. It is never sent to Claude — the Worker renders only `content` —
   but it means a bad answer can always be traced back to what ARDB actually
   published. Without it the consolidation would be unfalsifiable.

Entries already consolidated are skipped unless `--force`, so a re-run after a
partial failure costs only what failed.

Failures are reported by cause, because the response differs: a **figure
mismatch** needs the translation reviewed, a **transport failure** needs a
re-run, and a **rejected credential** stops the run on the first entry with
exit code 2 — it describes the configuration, not the corpus, so attributing
it to 33 entries would send a reader hunting for translation faults that do
not exist.

### Reading ARDB's numbers

The source pages write figures in Khmer numerals with a comma for the decimal
point and a full stop for thousands: `១,៥០%` is 1.50%, `១០០.០០០` is 100,000.
Read with English conventions, a 4.00% deposit rate becomes **400%** — so the
system prompt states the convention explicitly, tells Claude to convert to
Arabic numerals when answering in English, and to decline rather than quote a
figure that only makes sense under the other reading.

Rate tables are flattened out of HTML one row per line, cells joined by `" | "`
(typically term, then USD rate, then riel rate). Cell-per-line would leave the
term and the two currency rates indistinguishable, with the pairing surviving
only as position — close enough to guess wrong.

### Why the tooling is Python on Actions

The Worker never touches either host these tools do: `api.telegram.org` for
verification, `ardb.com.kh` for the corpus. Neither belongs on a request path,
both need unrestricted outbound network, and a GitHub runner has it. Keeping
them out of the Worker also keeps the deployed bundle small and its egress
surface to exactly two hosts: Telegram and the Claude API.

`tools/ardb/knowledge.py` owns the schema contract with
`src/core/knowledge.ts`. After consolidation an entry's `content` is English
and `sourceText` holds the Khmer original; only `content` is rendered into the
prompt. The Worker imports the JSON at build time, so a drift
between them breaks deployment rather than failing at runtime — CI asserts the
committed file parses, has unique IDs, and is sorted.

## Behaviour

| Situation | What happens |
|---|---|
| Non-text message (photo, voice, sticker) | Bilingual "please send text" |
| Second question while one is pending | Queued as its own ticket; customer told the earlier one is still in progress |
| More than 3 questions per minute | Bilingual rate-limit notice; no ticket filed |
| Claude fails, refuses, or is cut off | Card posted with the error and no ✅ button — the moderator must write the answer |
| Two moderators tap ✅ at once | One delivery; the loser is told it is already answered |
| Telegram retries a webhook | Deduplicated on `update_id` |
| Unknown `/command` | Ignored silently |
| Nobody answers for 10 min | Moderator group nudged, threaded under the card |
| Still unanswered after 45 min | Customer told once it is taking longer; group told they were told |

Tune the rate limit, model and SLA thresholds via `vars` in `wrangler.jsonc`.

### Chasing unanswered tickets

A Cron Trigger sweeps every five minutes. Candidates come from the database by
age; the decision per ticket is `core/sla.ts`, and the nudge and warning guards
live in the `UPDATE` statements, so two overlapping sweeps cannot double-send.

| Var | Default | Meaning |
|---|---|---|
| `SLA_NUDGE_AFTER_MINUTES` | 10 | Silence before the group is nudged |
| `SLA_NUDGE_REPEAT_MINUTES` | 30 | Minimum gap between repeat nudges |
| `SLA_MAX_NUDGES` | 3 | Cap per ticket; a group nudged indefinitely mutes the bot |
| `SLA_WARN_CUSTOMER_AFTER_MINUTES` | 45 | When the customer is told once that it is slow |

A ticket that is `claimed` still counts as unanswered — a moderator may have
tapped ✏️ Edit and then been called away. Past the nudge cap the ticket stays
open and visible but stops pinging.

## Audit trail

`ticket_events` records every question, draft, edit, approval, rejection and
delivery failure with actor and timestamp:

```sql
SELECT t.id, t.customer_name, t.question, t.draft, t.final_answer,
       e.event, e.actor_name, e.created_at
FROM tickets t JOIN ticket_events e ON e.ticket_id = t.id
ORDER BY t.id, e.created_at;
```

Resolved cards also stay in the moderator group as a visible record, marked
either *sent as drafted* or *sent (edited)* with the final text.

## Known gaps

This is scoped as an **internal demo**. Before real customers:

- **Data residency.** Workers execute at the edge, so customer messages may be
  processed outside Cambodia. Restricting that needs Cloudflare's Data
  Localization Suite (enterprise). If ARDB has a residency requirement,
  Cloudflare is the wrong host and this needs revisiting.
- **PII.** Questions will contain names, phone numbers and possibly account
  numbers. They are stored in Neon in full and sent to the Anthropic API.
  There is no redaction and no retention policy — `ticket_events` grows
  forever.
- **No conversation memory.** Each question is drafted standalone, so a
  follow-up like "and what about the interest rate?" loses its referent.
- **Moderator replies are trusted verbatim.** Whatever a moderator types is
  delivered unchanged. That is the design, but it means a mis-sent group
  message replying to a card goes to a customer.
- **No admin tooling.** No `/pending`, no `/stats`, no way to reassign a stuck
  ticket without SQL.

## Development

```bash
npm run check          # typecheck + Worker tests
npm run test:watch
npm run dev            # wrangler dev; delete the webhook first:
                       #   npm run set-webhook -- --delete

pip install -r tools/requirements-dev.txt
cd tools && python -m pytest
```

CI runs both suites plus `wrangler deploy --dry-run`, which catches what
typecheck and tests cannot: a bad `wrangler.jsonc`, a missing Node compat
flag, a JSON import that does not bundle.

A bot can have only one webhook, so local development and the deployed Worker
cannot both receive updates at once.
