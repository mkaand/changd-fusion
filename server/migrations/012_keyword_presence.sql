-- Additive text-monitoring mode. Existing monitors, captures, events, and
-- baselines remain unchanged; keyword state is derived from the existing text
-- baseline rather than stored in a separate mutable table.
ALTER TABLE fusion_monitors
  ADD COLUMN keyword text;

ALTER TABLE fusion_monitors
  DROP CONSTRAINT fusion_monitors_extraction_mode_check;

ALTER TABLE fusion_monitors
  ADD CONSTRAINT fusion_monitors_extraction_mode_check
  CHECK (extraction_mode IN ('full_text', 'selected_text', 'keyword_presence'));

ALTER TABLE fusion_monitors
  ADD CONSTRAINT fusion_monitors_keyword_check
  CHECK (
    (keyword IS NULL OR (char_length(keyword) <= 200 AND char_length(btrim(keyword)) >= 1))
    AND (extraction_mode <> 'keyword_presence' OR keyword IS NOT NULL)
  );

-- Direction-filtered changes remain part of history but intentionally do not
-- create an outbox delivery. The engine already records this explicit state;
-- include it in the database constraint so filtering cannot roll back a
-- successful capture transaction.
ALTER TABLE fusion_events
  DROP CONSTRAINT fusion_events_notification_state_check;

ALTER TABLE fusion_events
  ADD CONSTRAINT fusion_events_notification_state_check
  CHECK (notification_state IN ('not_requested','queued','muted','cooldown','duplicate_suppressed','disabled','digest_pending','direction_filtered'));
