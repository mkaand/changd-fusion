-- Sprint 3B: additive per-monitor notification controls and owner preferences.
ALTER TABLE fusion_monitors
  ADD COLUMN notification_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN muted_until timestamptz,
  ADD COLUMN notification_cooldown_seconds integer NOT NULL DEFAULT 0 CHECK(notification_cooldown_seconds IN (0,300,900,1800,3600,21600,86400)),
  ADD COLUMN notification_mode text NOT NULL DEFAULT 'immediate' CHECK(notification_mode IN ('immediate','digest')),
  ADD COLUMN digest_window_seconds integer NOT NULL DEFAULT 3600 CHECK(digest_window_seconds BETWEEN 300 AND 86400);
ALTER TABLE fusion_events
  ADD COLUMN notification_state text NOT NULL DEFAULT 'not_requested' CHECK(notification_state IN ('not_requested','queued','muted','cooldown','duplicate_suppressed','disabled','digest_pending')),
  ADD COLUMN notification_fingerprint text,
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE fusion_events DROP CONSTRAINT IF EXISTS fusion_events_status_check;
ALTER TABLE fusion_events ADD CONSTRAINT fusion_events_status_check CHECK(status IN ('baseline','unchanged','changed','failed','reset','legacy','test','digest'));
CREATE INDEX fusion_events_notification_fingerprint ON fusion_events(monitor_id,notification_fingerprint,created_at DESC) WHERE notification_fingerprint IS NOT NULL;
CREATE TABLE fusion_user_preferences (
  user_id varchar PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  monitoring_defaults jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fusion_notification_digests (
  monitor_id uuid NOT NULL REFERENCES fusion_monitors(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES fusion_channels(id) ON DELETE CASCADE,
  first_event_at timestamptz NOT NULL,
  last_event_at timestamptz NOT NULL,
  event_count integer NOT NULL DEFAULT 1 CHECK(event_count > 0),
  latest_event_id uuid NOT NULL REFERENCES fusion_events(id) ON DELETE CASCADE,
  due_at timestamptz NOT NULL,
  PRIMARY KEY(monitor_id,channel_id)
);
CREATE INDEX fusion_notification_digests_due ON fusion_notification_digests(due_at);
