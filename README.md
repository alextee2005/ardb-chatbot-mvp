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

```bash
# In BotFather: /newbot, then /setprivacy -> Disable (so the bot can read
# moderator replies in the group).
export TELEGRAM_BOT_TOKEN='...'

# Create a PRIVATE group, add the bot, send any message in it, then:
node scripts/get-chat-id.mjs
# -> use the negative group ID as MODERATOR_CHAT_ID
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

```bash
npm run scrape            # crawl www.ardb.com.kh
npm run scrape -- --dry-run   # see what it would keep first
```

Review the diff before committing. See `knowledge/README.md` for the format and
for hand-written entries, which survive a re-scrape.

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
│   ├── callbacks.ts     Inline-button payload encoding
│   └── moderator-card.ts  Card rendering and keyboards
├── adapters/            The outside world, one file per dependency
│   ├── telegram.ts      Bot API
│   ├── claude.ts        Messages API
│   └── store.ts         Neon over HTTP
└── handlers/
    ├── customer.ts      /start and questions
    └── moderator.ts     Button taps and edited answers
```

`core/` imports nothing platform-specific, which is what makes a move off
Cloudflare a rewrite of `worker.ts` and the three adapters rather than of the
business logic. The 48 tests cover `core/` only, and need no mocks.

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

Tune the rate limit and model via `vars` in `wrangler.jsonc`.

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
- **No SLA.** Nothing nudges moderators or warns the customer if a ticket sits
  unanswered. A customer told "please give me some time" may wait indefinitely.
- **No conversation memory.** Each question is drafted standalone, so a
  follow-up like "and what about the interest rate?" loses its referent.
- **Moderator replies are trusted verbatim.** Whatever a moderator types is
  delivered unchanged. That is the design, but it means a mis-sent group
  message replying to a card goes to a customer.
- **No admin tooling.** No `/pending`, no `/stats`, no way to reassign a stuck
  ticket without SQL.

## Development

```bash
npm run check          # typecheck + tests
npm run test:watch
npm run dev            # wrangler dev; delete the webhook first:
                       #   npm run set-webhook -- --delete
```

A bot can have only one webhook, so local development and the deployed Worker
cannot both receive updates at once.
