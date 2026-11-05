-- Editing presence is separate from the Chromium FIFO: it blocks scheduled
-- admission immediately, while Preview and Manual Check intents still own the
-- single interactive queue in creation order. Heartbeat expiry recovers
-- abandoned browser tabs without clearing leases or fencing tokens.
-- Intent creation time remains immutable for FIFO ordering; a distinct
-- heartbeat permits a legitimately queued Preview to wait beyond the original
-- 20-second window without losing ownership.
ALTER TABLE fusion_chromium_priority_intents
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE fusion_chromium_priority_intents
  DROP CONSTRAINT IF EXISTS fusion_chromium_priority_intents_check;
ALTER TABLE fusion_chromium_priority_intents
  DROP CONSTRAINT IF EXISTS fusion_chromium_priority_intents_expiry_check;
-- Rows created by v0.3.x already satisfy the original creation-window check.
-- Backfill their heartbeat to that immutable creation point before replacing
-- the constraint, including expired/cancelled evidence retained for audit.
UPDATE fusion_chromium_priority_intents
SET heartbeat_at=created_at
WHERE heartbeat_at<>created_at;
ALTER TABLE fusion_chromium_priority_intents
  ADD CONSTRAINT fusion_chromium_priority_intents_expiry_check
  CHECK (expires_at > heartbeat_at AND expires_at <= heartbeat_at + interval '20 seconds');

CREATE TABLE IF NOT EXISTS fusion_interactive_presence (
  id uuid PRIMARY KEY,
  owner_id varchar NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > heartbeat_at AND expires_at <= heartbeat_at + interval '20 seconds')
);
CREATE INDEX IF NOT EXISTS fusion_interactive_presence_active_idx
  ON fusion_interactive_presence(expires_at);

UPDATE fusion_chromium_scheduler
SET priority_window_until=NULL, scheduled_turn_until=NULL,
    scheduled_recovery_pending=false
WHERE id=1;
