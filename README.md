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

# Only for DRAFT_PROVIDER="github": a fine-grained token with Contents:
# write on this repository, so the Worker can trigger the drafting workflow.
# As a GitHub repository secret it must be named DISPATCH_TOKEN instead --
# GitHub refuses secret names starting with GITHUB_ -- and the deploy
# workflow renames it when setting it here.
npx wrangler secret put GITHUB_DISPATCH_TOKEN

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

`/health?schema=1` additionally reports any expected table or column the
database is missing, so "is the schema up to date?" is one request rather
than an inference. It needs `DATABASE_URL`; plain `/health` deliberately
does not, so it still answers on a Worker with no secrets set at all.

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

**A conversation is the unit of interaction, not a question.** `conversations`
groups the tickets of one Telegram chat, so a customer asking "what documents
do I need?" and then "and for a group loan?" produces one tracked interaction
with a start, an end and a question count -- rather than two unrelated tickets,
the second of which is unanswerable on its own. Earlier turns go to the
moderator card and into the drafting prompt.

At most one conversation per chat is open at a time, and the database enforces
it with a partial unique index rather than the Worker checking first. That is
what lets find-or-create be a single statement: two questions arriving in the
same second would both find nothing and both insert, splitting a thread in
half with no error to show for it. The conflict path doubles as the "another
question in the same conversation" path, so the common case and the race
resolve through the same branch.

**An interaction ends by asking, not by guessing.** Thirty quiet minutes after
the last activity (`FOLLOWUP_MINUTES`) the bot asks "is there anything else
that we can help you with?" with two buttons. **No** closes the conversation
as `completed` -- the only ending the customer actually confirms. **Yes**
clears the follow-up and invites the next question, and once that one is
answered the question comes round again, so the follow-up is per answer rather
than per conversation. Typing a new question instead of tapping does the same
thing and strips the now-meaningless buttons.

The follow-up is never sent while a question is still in the queue. An
"anything else?" arriving while the customer is still waiting reads as though
the bot forgot them -- rarer at half an hour than it was at three minutes, but
a question stuck in the queue overnight is exactly when it would sting most.

**The two windows are sequential, and that is load-bearing.** The follow-up
comes due 30 minutes after the last activity; the conversation is closed
`idleMinutes` (60) after the *follow-up was sent*, not after the last activity.
Measuring both from the same instant with the same value would have been the
obvious reading of "60 minutes consistently" and would have broken the feature
silently: the sweep closes conversations before it asks follow-ups, and only an
open conversation can be asked, so the follow-up would simply never have gone
out with nothing failing anywhere. A test asserts the ordering against
whatever the defaults become rather than against 30 and 60.

A conversation whose last question is still sitting unanswered never becomes
eligible for a follow-up at all, so there is a backstop: with no follow-up
sent, it closes `followupMinutes + idleMinutes` (90) after the last activity.
Without the sum it would stay open for ever and never be surveyed. The rule
exists twice -- `isConversationOver` in TypeScript, which decides whether an
arriving question joins the old thread, and the same two branches in SQL,
which decide when the thread is recorded as finished -- and they must agree,
or a question could be threaded onto a conversation the sweep had already
closed.

`/start` no longer ends a conversation. It did, and that was wrong: it
discarded the thread of anyone who tapped the menu button mid-conversation and
then asked a follow-up. An open conversation now survives a `/start` and the
greeting is just a greeting.

So `ended_reason` is one of `completed` (the customer said no), `idle` (the
follow-up went unanswered, or the backstop elapsed), `moderator`, or
`restarted` (retained for rows written before this change). The idle case is handled in
more than one place on purpose -- lazily when the next question arrives, which
is what keeps threading correct, and in the sweeps, which is what makes the
recorded end timely. Without that, the interactions that ended quietest would
be exactly the ones with no `ended_at`.

**Every ended interaction is surveyed.** Closing a conversation is what makes
it due a survey, and a sweep sends it: one path, so an interaction the customer
ended themselves and one that timed out are surveyed by identical code. The
survey is five buttons, 1 to 5, no free text -- a customer on a phone will
answer a tap and will not answer an essay.

Results go in `conversation_surveys`, which **snapshots** the question count,
the end reason and the start time rather than only referencing the
conversation. That is what lets a result stay interpretable after the weekly
archive has removed the conversation it rates: "4 out of 5, after 3 questions,
on an interaction the customer ended themselves" reads the same in a year. One
rating per conversation, enforced by a partial unique index, because a customer
tapping twice is expressing one opinion and two rows would quietly
double-count them in any average.

**Customer taps are authorized differently from moderator taps.** A moderator
card lives in one private group, so being able to see it is proof enough. A
customer's buttons live in their own chat and the conversation id travels in
callback data the client could edit, so every customer handler confirms the
conversation actually belongs to the chat the tap came from -- otherwise a
hand-edited payload would let one customer end another's conversation or file a
satisfaction score against it. The two namespaces have separate parsers that
each reject the other's payloads, and a test asserts that.

**One Cron Trigger, and the schedule lives in code.** `wrangler.jsonc`
declares `* * * * *`; `scheduledWork` in `src/core/schedule.ts` decides what
each minute is for -- engagement every minute, the SLA sweep every fifth, the
archive on Sunday at 03:17 UTC with a retry at 03:47.

It was three triggers matched against `event.cron`, and that failed twice in
one afternoon. Cloudflare numbers the day-of-week field 1 = Sunday where
crontab uses 0, so `17 3 * * 0` was rejected by the schedules API *after* the
Worker had uploaded -- and `7`, the obvious correction, would have deployed
cleanly and run the archive on Saturday. Then the Workers Free plan turned out
to allow 5 cron triggers per *account*, and three did not fit alongside what
the account already had.

One trigger has no syntax left to get wrong, needs no second copy kept in step
with the Worker, and leaves four of the five slots free. The schedule becomes
a pure function of the clock, which is testable where a cron string was not: a
test walks a whole week minute by minute and asserts the archive fires exactly
twice. The retry is there because a single missed invocation would otherwise
skip the week, and the archive is idempotent -- a second run either finds
nothing or continues a backlog.

**The weekly archive copies before it deletes, and deletes only what it can
prove it copied.** Closed conversations older than `ARCHIVE_AFTER_DAYS`
(default 7) move to `conversations_history`, `tickets_history` and
`ticket_events_history`, in that dependency order. The HTTP driver has no
transaction spanning statements, so the ordering is chosen for its failure
modes: if the copy fails nothing is deleted; if the copy succeeds and the
delete is interrupted, rows sit in both places and the next run's copy is a
no-op while the delete retries. Neither loses a record. Every `DELETE` carries
an `EXISTS (SELECT 1 FROM ..._history ...)` guard, so an interruption at any
point cannot destroy a customer record with nothing to restore from -- for a
bank that is worth contorting the code to make impossible. Both failure modes
are verified against a real PostgreSQL, not reasoned about.

The history tables are created with `LIKE ... EXCLUDING ALL`: same columns, no
foreign keys, no checks, no cascades. An archive exists to be readable years
later, and a rule added to a live table in 2027 must not be able to reject a
row written in 2026.

`EXCLUDING ALL` does not quite deliver that on its own, which only showed up
under a real Postgres: `NOT NULL` is part of a column definition rather than a
table constraint, so it is always copied while the `DEFAULT` that made it
satisfiable is not. That leaves the worst of both -- add a `NOT NULL DEFAULT`
column to `tickets` and the archive of an older row would be rejected for a
column that did not exist when it was written, in a weekly job, on a bank's
correspondence. The migration therefore drops `NOT NULL` from every history
column except the primary key and `archived_at`, in a loop over
`information_schema` rather than a hand-maintained list that would drift out
of step with the live tables. The archive copies whole rows, so nothing is
lost by allowing nulls.

An open conversation is never archived whatever its age, and survey results
are never archived at all.

History travels in the user turn, never the cached system prefix. The prefix
must stay byte-identical for the prompt cache to hit, and history differs on
every request; a test asserts the separation, because moving it would quietly
cost a full-corpus charge on every question. The prompt also restates the
grounding rules alongside the history, since a rate the model quoted last turn
must not become established fact this turn -- for a bank that is the failure
that matters most.

Only `final_answer` is replayed, never a draft. A draft nobody approved was
never part of the conversation, and a rejected one may have been rejected
precisely because it was wrong.

**Retention is ten years.** The weekly archive moves closed conversations out
of the live tables after `ARCHIVE_AFTER_DAYS` (7), and the same weekly run
deletes archived interactions once they pass `HISTORY_RETENTION_YEARS` (10).
Both halves run in one job so their scheduling cannot drift apart.

The clock runs from the date of the interaction itself -- `ended_at` -- not
from `archived_at`, because the period a compliance policy means starts when
the conversation happened, not when a cron job happened to move it a week
later. Deletion is driven off the conversation and takes its tickets and
events with it, rather than deleting each table by its own age: a ticket
created days before its conversation ended is older than the conversation, and
deleting by age alone would leave interactions half-present in the archive.
Satisfaction results are on the same clock but measured from when they were
given, since by then they have outlived the conversation they rate and have no
parent to drive from -- they carry the customer's chat and user id, so keeping
them for ever would keep identifying data for ever, and a score from eleven
years ago informs nothing.

**Drafting is pluggable, and optional.** `DRAFT_PROVIDER` picks between
`workers-ai` (the default), `claude`, `github`, and `none`. The handler holds a
draft function rather than a provider's configuration, so a third provider
touches `worker.ts` and one adapter, not the flow. A provider that cannot run
-- the `claude` setting with no API key -- resolves to `none` rather than
failing every webhook call, and `/health` reports which one is actually in
effect.

**The `github` route can draft on a Claude subscription, with no API key.**
The Worker sends a `repository_dispatch` carrying a ticket ID and nothing
else; `draft-ticket.yml` reads the question from Postgres and runs the Claude
Code CLI. Authenticate it by running `claude setup-token` on your own machine
and adding the output as a `CLAUDE_CODE_OAUTH_TOKEN` repository secret:
drafting then draws on the subscription and costs nothing per question. An
`ANTHROPIC_API_KEY` still works and is used only when that token is absent,
with a warning that it is the billed path.

Worth being exact about, because it is easy to assume otherwise: routing
through Actions does not by itself avoid paying per token. It moves where the
Anthropic call is made, not whether it is billed. The subscription token is
what avoids it. An exhausted API balance, incidentally, arrives as a 400
`invalid_request_error` rather than a 402, so the adapter classifies it
explicitly instead of reporting a malformed request.

The question travels as a file on the runner, never as a command argument or
a log line, and the drafting step runs with no tools and one turn. The step
that stores the draft runs even when the CLI step fails, so a card never sits
mid-draft: it either carries a suggested answer or says why it does not, and
Edit works in both cases.

**Workers AI needs no credential at all.** Inference runs on Cloudflare
through the `AI` binding, so there is no key to leak or fund. 10,000 neurons a
day are free, resetting at 00:00 UTC. On `@cf/openai/gpt-oss-20b` a question
costs roughly 440 neurons -- about 22 free a day, which suits a test bot. Two
properties of Workers AI drive the model choice: there is no prompt cache, so
every question pays full price for the whole corpus; and context windows vary
sharply by model, and the corpus is ~20,000 tokens of that window before the
question is added. Past the daily allowance the card says so and names the
reset time, and the moderator writes the reply.

**Claude Haiku 5.5 at `low` effort** (when `DRAFT_PROVIDER=claude`)**.** Around $0.003 a question against
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
