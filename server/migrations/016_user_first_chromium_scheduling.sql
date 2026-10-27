-- Additive durable intents coordinate the single Chromium tree between API and
-- Worker replicas.  Expiry makes abandoned requests self-healing.
CREATE TABLE IF NOT EXISTS fusion_chromium_priority_intents (
  id uuid PRIMARY KEY,
  owner_id varchar NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('preview','manual')),
  monitor_id uuid REFERENCES fusion_monitors(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz NULL,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '20 seconds')
);
CREATE INDEX IF NOT EXISTS fusion_chromium_priority_intents_active_idx
  ON fusion_chromium_priority_intents(expires_at) WHERE cancelled_at IS NULL;

CREATE TABLE IF NOT EXISTS fusion_manual_runs (
  id uuid PRIMARY KEY,
  monitor_id uuid NOT NULL REFERENCES fusion_monitors(id) ON DELETE CASCADE,
  user_id varchar NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  priority_intent_id uuid REFERENCES fusion_chromium_priority_intents(id),
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')) DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fusion_manual_runs_open_monitor_idx
  ON fusion_manual_runs(monitor_id) WHERE status IN ('queued','running');

-- The advisory lock disappearing is not evidence that Chromium exited. This
-- durable fence is cleared ONLY by the owner after confirmed browser/proxy
-- cleanup. A dead process leaves a quarantine requiring supervised recovery.
CREATE TABLE IF NOT EXISTS fusion_chromium_scheduler (
  id integer PRIMARY KEY CHECK (id=1),
  active_token uuid,
  active_workload text CHECK (active_workload IN ('capture','preview')),
  active_since timestamptz,
  priority_window_until timestamptz,
  last_interactive_at timestamptz,
  scheduled_turn_until timestamptz,
  scheduled_recovery_pending boolean NOT NULL DEFAULT false,
  CHECK ((active_token IS NULL) = (active_workload IS NULL))
);
INSERT INTO fusion_chromium_scheduler(id) VALUES(1) ON CONFLICT DO NOTHING;

ALTER TABLE fusion_events DROP CONSTRAINT IF EXISTS fusion_events_status_check;
ALTER TABLE fusion_events ADD CONSTRAINT fusion_events_status_check
  CHECK(status IN ('baseline','unchanged','changed','failed','reset','legacy','test','digest','extraction_transition','skipped'));
