-- Add fixed-viewport selected-area capture without rewriting existing monitor
-- configuration, baselines, captures, events, or notification preferences.
ALTER TABLE fusion_monitors
  ADD COLUMN capture_area jsonb;

ALTER TABLE fusion_monitors
  DROP CONSTRAINT fusion_monitors_capture_mode_check;

ALTER TABLE fusion_monitors
  ADD CONSTRAINT fusion_monitors_capture_mode_check
  CHECK (capture_mode IN ('viewport', 'full_page', 'element', 'selected_area'));

ALTER TABLE fusion_monitors
  ADD CONSTRAINT fusion_monitors_capture_area_check
  CHECK (
    (
      capture_area IS NULL
      OR (
        jsonb_typeof(capture_area) = 'object'
        AND capture_area ?& ARRAY['x', 'y', 'width', 'height']
        AND capture_area - ARRAY['x', 'y', 'width', 'height'] = '{}'::jsonb
        AND jsonb_typeof(capture_area->'x') = 'number'
        AND jsonb_typeof(capture_area->'y') = 'number'
        AND jsonb_typeof(capture_area->'width') = 'number'
        AND jsonb_typeof(capture_area->'height') = 'number'
        AND capture_area->>'x' ~ '^[0-9]+$'
        AND capture_area->>'y' ~ '^[0-9]+$'
        AND capture_area->>'width' ~ '^[0-9]+$'
        AND capture_area->>'height' ~ '^[0-9]+$'
        AND (capture_area->>'x')::numeric >= 0
        AND (capture_area->>'y')::numeric >= 0
        AND (capture_area->>'width')::numeric >= 16
        AND (capture_area->>'height')::numeric >= 16
        AND (capture_area->>'x')::numeric + (capture_area->>'width')::numeric <= 1280
        AND (capture_area->>'y')::numeric + (capture_area->>'height')::numeric <= 900
      )
    )
    AND ((capture_mode = 'selected_area') = (capture_area IS NOT NULL))
    AND (capture_mode <> 'selected_area' OR (kind = 'browser' AND visual_enabled))
  );
