-- Additive migration: never alter a previously applied migration/checksum.
ALTER TABLE fusion_monitors
  ADD COLUMN capture_mode text NOT NULL DEFAULT 'viewport' CHECK(capture_mode IN ('viewport','full_page','element')),
  ADD COLUMN capture_selector text NOT NULL DEFAULT '' CHECK(length(capture_selector)<=1000),
  ADD COLUMN last_dimension_change boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT element_capture_selector CHECK(capture_mode<>'element' OR length(trim(capture_selector))>0);
ALTER TABLE fusion_events
  ADD COLUMN dimension_changed boolean NOT NULL DEFAULT false,
  ADD COLUMN before_dimensions jsonb,
  ADD COLUMN after_dimensions jsonb;
