-- Conversations: one customer's interaction from start to end.
--
-- Until now a question was the largest unit the bot understood, so a customer
-- asking "what documents do I need?" and then "and for a group loan?" filed
-- two unrelated tickets. The moderator saw the second with no sight of the
-- first, and the draft was written as though the conversation had just begun.
-- A conversation groups the tickets of one Telegram chat so both the moderator
-- and the model can see what has already been said.
--
-- Keyed on customer_chat_id rather than customer_user_id: the chat is where
-- the conversation visibly happens, and it is what the bot replies into.
--
-- Retention: these rows hold customer questions and the answers sent back,
-- which is personal data and in a bank's case likely regulated. Nothing here
-- deletes it. A retention policy is a decision for ARDB, not a default this
-- migration should pick, but it does need making -- see README.

CREATE TABLE IF NOT EXISTS conversations (
  id                BIGSERIAL PRIMARY KEY,
  customer_chat_id  BIGINT      NOT NULL,
  customer_user_id  BIGINT      NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','closed')),
  -- Why it ended, so "the customer stopped replying" and "the customer typed
  -- /start again" are distinguishable when reading the history back.
  ended_reason      TEXT        CHECK (ended_reason IN ('idle','restarted','moderator')),
  question_count    INTEGER     NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ
);

-- At most one open conversation per chat, enforced by the database rather than
-- by a read-then-write in the Worker.
--
-- This is what makes find-or-create a single atomic statement: two questions
-- arriving in the same second cannot produce two conversations, which a
-- SELECT-then-INSERT would allow and which would split a thread in half.
-- A partial index, so closed conversations accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_open_per_chat
  ON conversations (customer_chat_id)
  WHERE status = 'open';

-- The idle sweep's query: open conversations, least recently active first.
CREATE INDEX IF NOT EXISTS conversations_open_activity_idx
  ON conversations (last_activity_at)
  WHERE status = 'open';

-- Reading one customer's history back, newest first.
CREATE INDEX IF NOT EXISTS conversations_chat_idx
  ON conversations (customer_chat_id, started_at DESC);

-- Nullable, and ON DELETE SET NULL rather than CASCADE: a ticket is the
-- record of a question that was really asked and answered, and deleting a
-- conversation must not take the audit trail with it. Existing tickets keep
-- NULL, which reads correctly as "from before conversations existed".
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS conversation_id BIGINT
    REFERENCES conversations(id) ON DELETE SET NULL;

-- Fetching the earlier turns of a conversation when drafting a later one.
CREATE INDEX IF NOT EXISTS tickets_conversation_idx
  ON tickets (conversation_id, created_at)
  WHERE conversation_id IS NOT NULL;
