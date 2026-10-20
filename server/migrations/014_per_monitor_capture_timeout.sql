-- Existing monitors retain NULL and therefore the legacy CAPTURE_TIMEOUT_MS fallback.
-- New monitors store an explicit, user-selected bounded timeout.
ALTER TABLE fusion_monitors
  ADD COLUMN capture_timeout_ms integer;

ALTER TABLE fusion_monitors
  ADD CONSTRAINT fusion_monitors_capture_timeout_ms_check
  CHECK (capture_timeout_ms IS NULL OR capture_timeout_ms IN (30000, 45000, 60000, 75000, 90000));
