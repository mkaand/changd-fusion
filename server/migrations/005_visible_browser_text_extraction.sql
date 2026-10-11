-- Browser text capture v2 excludes non-rendered framework state. Existing browser
-- text monitors transition on their next successful capture without an alert.
ALTER TABLE fusion_monitors
  ADD COLUMN browser_text_extraction_version integer NOT NULL DEFAULT 2
  CHECK (browser_text_extraction_version BETWEEN 1 AND 2);

ALTER TABLE fusion_events DROP CONSTRAINT IF EXISTS fusion_events_status_check;
ALTER TABLE fusion_events ADD CONSTRAINT fusion_events_status_check
  CHECK(status IN ('baseline','unchanged','changed','failed','reset','legacy','test','digest','extraction_transition'));

UPDATE fusion_monitors
SET browser_text_extraction_version=1
WHERE kind='browser' AND text_enabled;
