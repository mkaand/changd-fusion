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
    (keyword IS NULL OR char_length(btrim(keyword)) BETWEEN 1 AND 200)
    AND (extraction_mode <> 'keyword_presence' OR keyword IS NOT NULL)
  );
