-- ARDB chatbot schema.
--
-- `tickets` is the live queue; `ticket_events` is the append-only audit trail
-- (every question, draft, edit, approval and rejection, with who and when).
-- Even for an internal demo the trail is near-free to write and impossible to
-- reconstruct after the fact, which is the whole reason it exists.

CREATE TABLE IF NOT EXISTS tickets (
  id                BIGSERIAL PRIMARY KEY,
  customer_chat_id  BIGINT      NOT NULL,
  customer_user_id  BIGINT      NOT NULL,
  customer_name     TEXT        NOT NULL,
  customer_username TEXT,
  question          TEXT        NOT NULL,
  question_language TEXT        NOT NULL,
  draft             TEXT,
  draft_error       TEXT,
  final_answer      TEXT,
  status            TEXT        NOT NULL DEFAULT 'drafting'
                      CHECK (status IN ('drafting','awaiting','claimed','sent','rejected')),
  claimed_by        BIGINT,
  claimed_by_name   TEXT,
  card_message_id   BIGINT,
  prompt_message_id BIGINT,
  knowledge_version TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Finding the open tickets for one customer, for the rate limit and the
-- "still working on your last question" reply.
CREATE INDEX IF NOT EXISTS tickets_customer_idx
  ON tickets (customer_user_id, created_at DESC);

-- Resolving a moderator's force-reply back to the ticket it belongs to.
CREATE INDEX IF NOT EXISTS tickets_prompt_message_idx
  ON tickets (prompt_message_id)
  WHERE prompt_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tickets_card_message_idx
  ON tickets (card_message_id)
  WHERE card_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ticket_events (
  id          BIGSERIAL PRIMARY KEY,
  ticket_id   BIGINT      NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event       TEXT        NOT NULL,
  actor_id    BIGINT,
  actor_name  TEXT,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx
  ON ticket_events (ticket_id, created_at);

-- Telegram retries a webhook it believes failed, and retries carry the same
-- update_id. Without this a retry would file a second ticket for one question.
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id    BIGINT      PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processed_updates_age_idx
  ON processed_updates (processed_at);
