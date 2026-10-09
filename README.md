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

**This is what decides whether the bot is useful.** It is already populated —
33 ARDB pages, all restated in English — and it is kept current by two
workflows that run in sequence.

```
www.ardb.com.kh ──1──▶ knowledge/raw/ardb-raw.json ──2──▶ knowledge/corpus/ardb-corpus.json ──▶ the bot
                       as published (Khmer/English)        one language, reviewed
```

| | workflow | writes | the bot |
| --- | --- | --- | --- |
| **1** | Scrape ARDB pages (stage 1) | `knowledge/raw/` | unaffected |
| **2** | Build corpus (stage 2) | `knowledge/corpus/` | answers from this |

Stage 1 archives the pages exactly as ARDB publishes them and stops. Stage 2
converts that archive into the single-language corpus the Worker imports, and
runs automatically once a stage 1 pull request lands on the default branch.
Both open pull requests rather than committing directly, because an unreviewed
knowledge file is how a navigation blob or a wrong interest rate reaches a
customer.

Keeping the two apart is the point. While one file served both purposes, a
re-scrape silently replaced reviewed English with raw Khmer — and the prompt
kept telling Claude the source material was English. Now a scrape cannot
change anything a customer sees; only a merged stage 2 can.

> **One repository setting.** `GITHUB_TOKEN` cannot open a pull request unless
> *Settings → Actions → General → Workflow permissions → Allow GitHub Actions
> to create and approve pull requests* is enabled, and it is off by default.
> Without it a workflow still does its work and pushes the branch, then prints
> a one-click link to open the pull request yourself — nothing is lost to that
> setting.

Locally instead:

```bash
pip install -r tools/requirements.txt
python tools/scrape_knowledge.py --dry-run   # stage 1: see what it would keep
python tools/scrape_knowledge.py             # stage 1: write the archive
python tools/build_corpus.py                 # stage 2: build the corpus
python tools/build_corpus.py --check         # is the corpus current?
```

`knowledge/HISTORY.jsonl` is the ledger: one line per scrape and per build,
with its timestamp, entry count, content digest and — for a build — the
archive it came from. See `knowledge/README.md` for the format, for
hand-written entries, and for the two products where ARDB's own pages publish
different interest rates.

### 4. Secrets and deploy

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in, for local `wrangler dev`

for name in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET MODERATOR_CHAT_ID \
            DATABASE_URL; do
  npx wrangler secret put "$name"
done

# Optional. Without it the bot runs moderator-only: tickets and cards still
# work, a person writes every answer. `/health` reports which mode it is in.
npx wrangler secret put ANTHROPIC_API_KEY

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

knowledge/
├── raw/ardb-raw.json       Stage 1: the pages as ARDB published them
├── corpus/ardb-corpus.json Stage 2: one language, what the Worker imports
├── HISTORY.jsonl           Ledger: every scrape and build, with timestamps
└── restatements/           The English, hand-written and figure-checked

tools/                   Python, run on GitHub Actions
├── verify_bot.py        Token, privacy setting, webhook, visible chat IDs
├── scrape_knowledge.py  Stage 1: crawl -> raw archive -> pull-request body
├── build_corpus.py      Stage 2: raw archive -> English corpus (no network)
├── consolidate_knowledge.py  Stage 2 via Claude, for pages with no restatement
├── ardb/
│   ├── knowledge.py     The schema contract with src/core/knowledge.ts
│   ├── scraper.py       Crawl filters and HTML extraction
│   ├── normalize.py     Khmer numerals and separators -> English notation
│   ├── consolidate.py   The restatement call and its figure-preservation guard
│   └── telegram.py      Read-only Bot API client
└── tests/               234 tests, including a crawl against a fixture site

.github/
├── actions/open-pr/      Commit, push, open a PR; degrades to a link
└── workflows/
    ├── ci.yml            Typecheck, both test suites, Worker bundle, corpus checks
    ├── verify-bot.yml    Manual bot verification
    ├── scrape-knowledge.yml  Stage 1: manual or monthly, opens a PR
    └── build-corpus.yml  Stage 2: on a merged stage 1, or manual
```

`core/` imports nothing platform-specific, which is what makes a move off
Cloudflare a rewrite of `worker.ts` and the three adapters rather than of the
business logic. The 65 tests cover `core/` only, and need no mocks.

### Decisions worth knowing

**The webhook acknowledges Telegram before doing any work.** The question is
handled in `ctx.waitUntil`. Telegram retries a webhook it considers slow, and a
retry would file a second ticket for one question — so the fast `200` plus the
`processed_updates` dedupe table are two halves of one defence.

**Claude Haiku 5.5 at `low` effort.** Around $0.003 a question against
$0.02-0.13 on Opus 5.5, and the moderator review every draft already goes
through is what makes that trade reasonable: nothing reaches a customer
unread. On both models `budget_tokens` is rejected and thinking cannot be
switched off, so `output_config.effort` is the only control; its default is
`medium`, and it is set explicitly.

**Haiku has no server-side refusal fallback**, so a safety decline cannot be
retried on another model — `fallbacks: "default"` would leave a declined
request declined. `src/adapters/claude.ts` therefore sends that parameter only
to the models that have it, and a refusal reaches the moderator card naming
its category for them to answer by hand. Change the model in `wrangler.jsonc`
without touching code; the fallback behaviour follows the model
automatically.

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

ARDB publishes mostly in Khmer. Stage 2 restates every page as English
reference material, so the corpus the Worker sends is one language and one
representation.

`tools/build_corpus.py` is the primary route and needs no API key: the English
lives in `knowledge/restatements/`, written by reading each page, and the
build is a pure function of two files already in git — the same archive and
the same restatements always produce the same corpus, which CI asserts.

`tools/consolidate_knowledge.py` is the paid route, for a page no restatement
module covers. It restates with Claude under the same figure-preservation
guard:

```bash
ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py
ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py --dry-run
ANTHROPIC_API_KEY=... python tools/consolidate_knowledge.py --only faq --force
```

It needs an `ANTHROPIC_API_KEY` repository secret. No workflow runs it
automatically: a step that spends money on every scrape is the wrong default
when the hand-written route is free and reproducible.

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
4. **The published page is retained twice over.** `sourceText` on every
   restated entry holds it verbatim, and `knowledge/raw/` holds the whole
   archive independently of any corpus. Neither is ever sent to Claude — the
   Worker renders only `content` — but between them a bad answer can always be
   traced back to what ARDB actually published. Without that the restatement
   would be unfalsifiable.

Entries already consolidated are skipped unless `--force`, so a re-run after a
partial failure costs only what failed.

Failures are reported by cause, because the response differs: a **figure
mismatch** needs the translation reviewed, a **transport failure** needs a
re-run, and a **rejected credential** stops the run on the first entry with
exit code 2 — it describes the configuration, not the corpus, so attributing
it to 33 entries would send a reader hunting for translation faults that do
not exist.

### Reading ARDB's numbers

The source pages write figures in Khmer numerals, and ARDB uses the comma
**both** ways — so the separator alone cannot tell you which it is. What
decides is the size of the group after it: one or two digits is a decimal
fraction, exactly three is a thousands group.

| Source | Comma/stop means | Value |
|---|---|---|
| `១,៥០%` | decimal point | 1.50% |
| `៤០,០០០` riel | thousands | 40,000 |
| `១០០.០០០` | thousands | 100,000 |

Getting this wrong is not cosmetic in either direction: read a rate the wrong
way and 4.00% becomes **400%**; read the savings minimum the wrong way and
40,000 riel becomes **40**. Assuming the comma was always a decimal point did
exactly that, until the real corpus showed both usages on the same site. The
normalizer now decides per figure, and only regroups when the source itself
grouped — so a year like `2019.08` is not turned into `2,019.08`.

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
