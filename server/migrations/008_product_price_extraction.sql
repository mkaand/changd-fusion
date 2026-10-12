-- Optional, deterministic selling-price extraction for Jina Reader monitors.
ALTER TABLE fusion_monitors
  ADD COLUMN extraction_mode text NOT NULL DEFAULT 'full_text'
    CHECK (extraction_mode IN ('full_text','product_price'));
