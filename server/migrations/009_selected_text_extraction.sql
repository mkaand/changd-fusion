ALTER TABLE fusion_monitors
  DROP CONSTRAINT fusion_monitors_extraction_mode_check;

ALTER TABLE fusion_monitors
  ADD CONSTRAINT fusion_monitors_extraction_mode_check
  CHECK (extraction_mode IN ('full_text', 'product_price', 'selected_text'));

ALTER TABLE fusion_monitors
  ADD COLUMN extraction_rule jsonb;
