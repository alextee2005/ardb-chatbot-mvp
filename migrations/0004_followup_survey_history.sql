-- Ending an interaction deliberately, measuring it, and archiving it.
--
-- Three related changes:
--   1. An interaction now ends by asking the customer, not by guessing. Three
--      minutes after the last answer the bot asks "is there anything else?",
--      and the answer decides whether the conversation continues or closes.
--   2. Every ended interaction is surveyed for satisfaction, and the result is
--      stored here.
--   3. Closed conversations are archived weekly into history tables, so the
--      live queue stays small without destroying the record.

-- --------------------------------------------------------------------
-- 1. Follow-up state
-- --------------------------------------------------------------------

-- Nullable and reset per answer, not per conversation: after each answer the
-- customer is asked again, which is the natural behaviour -- someone who says
-- "yes" and asks a second question should be asked again once that is
-- answered, not left to time out.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followup_sent_at TIMESTAMPTZ;

-- The message carrying the Yes/No buttons, so they can be stripped once one is
-- tapped. Without it an old follow-up keeps live buttons for ever and a tap
-- days later would act on a conversation that has long since closed.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followup_message_id BIGINT;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS survey_sent_at TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS survey_message_id BIGINT;

-- 'completed' is the new reason: the customer said there was nothing else.
-- That is the only ending that is actually confirmed by the customer, so it is
-- worth distinguishing from a conversation that merely went quiet.
--
-- Dropped and recreated rather than added to, because a CHECK constraint
-- cannot be extended in place. Named explicitly so this is repeatable.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_ended_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_ended_reason_check
  CHECK (ended_reason IN ('idle','restarted','moderator','completed'));

-- The follow-up sweep's query: open conversations with no follow-up yet,
-- least recently active first.
CREATE INDEX IF NOT EXISTS conversations_followup_due_idx
  ON conversations (last_activity_at)
  WHERE status = 'open' AND followup_sent_at IS NULL;

-- --------------------------------------------------------------------
-- 2. Satisfaction survey
-- --------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_surveys (
  id                      BIGSERIAL PRIMARY KEY,
  -- SET NULL, not CASCADE: the whole point of a survey result is to outlive
  -- the conversation it rates. The weekly archive deletes conversations, and
  -- satisfaction history must survive that.
  conversation_id         BIGINT      REFERENCES conversations(id) ON DELETE SET NULL,
  customer_chat_id        BIGINT      NOT NULL,
  customer_user_id        BIGINT      NOT NULL,
  score                   SMALLINT    NOT NULL CHECK (score BETWEEN 1 AND 5),
  -- Snapshotted from the conversation at the moment of answering, so a result
  -- stays interpretable -- "4 out of 5, after 3 questions, on an interaction
  -- that ended because the customer said they were done" -- once the
  -- conversation row itself has been archived away.
  question_count          INTEGER,
  ended_reason            TEXT,
  conversation_started_at TIMESTAMPTZ,
  responded_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One rating per conversation. A customer who taps twice is expressing one
-- opinion, and two rows would quietly double-count them in any average.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_surveys_one_per_conversation
  ON conversation_surveys (conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_surveys_responded_idx
  ON conversation_surveys (responded_at DESC);

-- --------------------------------------------------------------------
-- 3. History tables
-- --------------------------------------------------------------------
--
-- Deliberately plain: same columns as the live tables plus archived_at, no
-- foreign keys, no CHECK constraints, no cascades. An archive exists to be
-- readable years later, and a constraint added to a live table in 2027 must
-- not be able to reject a row written in 2026.
--
-- LIKE ... EXCLUDING ALL copies the column names and types and nothing else,
-- so these stay structurally in step with the live tables without inheriting
-- their rules. It also means a future ALTER to a live table needs the same
-- ALTER here -- the alternative, generating these at archive time, would hide
-- a schema drift until the week it lost data.

CREATE TABLE IF NOT EXISTS conversations_history (
  LIKE conversations EXCLUDING ALL
);
ALTER TABLE conversations_history ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- A primary key here is what makes the archive idempotent: a re-run after a
-- partial failure re-inserts nothing (ON CONFLICT DO NOTHING) rather than
-- duplicating the history.
ALTER TABLE conversations_history DROP CONSTRAINT IF EXISTS conversations_history_pkey;
ALTER TABLE conversations_history ADD PRIMARY KEY (id);

CREATE TABLE IF NOT EXISTS tickets_history (
  LIKE tickets EXCLUDING ALL
);
ALTER TABLE tickets_history ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE tickets_history DROP CONSTRAINT IF EXISTS tickets_history_pkey;
ALTER TABLE tickets_history ADD PRIMARY KEY (id);

CREATE INDEX IF NOT EXISTS tickets_history_conversation_idx
  ON tickets_history (conversation_id);

CREATE TABLE IF NOT EXISTS ticket_events_history (
  LIKE ticket_events EXCLUDING ALL
);
ALTER TABLE ticket_events_history ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE ticket_events_history DROP CONSTRAINT IF EXISTS ticket_events_history_pkey;
ALTER TABLE ticket_events_history ADD PRIMARY KEY (id);

CREATE INDEX IF NOT EXISTS ticket_events_history_ticket_idx
  ON ticket_events_history (ticket_id, created_at);
