-- Additive browser experience controls. Existing monitors retain their prior desktop,
-- JavaScript-enabled, normal-error handling behaviour.
ALTER TABLE fusion_monitors
  ADD COLUMN monitor_http_error_pages boolean NOT NULL DEFAULT false,
  ADD COLUMN disable_javascript boolean NOT NULL DEFAULT false,
  ADD COLUMN block_ads_trackers boolean NOT NULL DEFAULT false,
  ADD COLUMN cookie_banner_handling boolean NOT NULL DEFAULT false,
  ADD COLUMN wait_before_capture_ms integer NOT NULL DEFAULT 0
    CHECK (wait_before_capture_ms IN (0, 2000, 5000, 10000)),
  ADD COLUMN mobile_view boolean NOT NULL DEFAULT false,
  ADD COLUMN last_http_status integer NULL
    CHECK (last_http_status BETWEEN 100 AND 599);

ALTER TABLE fusion_captures
  ADD COLUMN http_status integer NULL CHECK (http_status BETWEEN 100 AND 599);

ALTER TABLE fusion_events
  ADD COLUMN http_status integer NULL CHECK (http_status BETWEEN 100 AND 599),
  ADD COLUMN http_status_changed boolean NOT NULL DEFAULT false;
