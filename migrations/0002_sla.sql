-- Service-level tracking for tickets nobody has answered.
--
-- A customer told "please give me some time" has no way to tell the
-- difference between a moderator thinking and a moderator who never saw the
-- card. These columns let a scheduled sweep nudge the group and, if it stays
-- unanswered, tell the customer honestly that it is taking longer.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS nudge_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS last_nudged_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_warned_at TIMESTAMPTZ;

-- The sweep's only query: open tickets, oldest first. Partial index because
-- resolved tickets are the overwhelming majority over time and none of them
-- are ever candidates.
CREATE INDEX IF NOT EXISTS tickets_open_age_idx
  ON tickets (created_at)
  WHERE status NOT IN ('sent','rejected');
