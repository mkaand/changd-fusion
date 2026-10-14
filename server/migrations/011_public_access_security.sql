-- Additive Sprint 5 authentication and public workspace state. Existing monitors, history and sessions remain valid.
CREATE TABLE fusion_access_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  public_enabled boolean NOT NULL DEFAULT false,
  owner_user_id varchar REFERENCES users(user_id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fusion_access_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;

ALTER TABLE fusion_sessions
  ADD COLUMN refresh_token_hash text,
  ADD COLUMN refresh_expires_at timestamptz,
  ADD COLUMN security_expires_at timestamptz;
UPDATE fusion_sessions SET refresh_expires_at=expires_at WHERE refresh_expires_at IS NULL;
ALTER TABLE fusion_sessions ALTER COLUMN refresh_expires_at SET NOT NULL;
CREATE INDEX fusion_sessions_refresh ON fusion_sessions(user_id, refresh_expires_at) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX fusion_sessions_refresh_hash ON fusion_sessions(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;

CREATE TABLE fusion_security_grants (
  id uuid PRIMARY KEY,
  user_id varchar NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  session_id uuid REFERENCES fusion_sessions(id) ON DELETE CASCADE,
  browser_token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fusion_security_grants_active ON fusion_security_grants(user_id, expires_at) WHERE revoked_at IS NULL;

-- Product Price is retired. Historical captures/events remain untouched, but
-- price-only baselines are not comparable with Full Text. Force a new baseline
-- instead of silently treating the next document as a product-price change.
ALTER TABLE fusion_monitors DROP CONSTRAINT IF EXISTS fusion_monitors_extraction_mode_check;
WITH transitioned AS (
  UPDATE fusion_monitors
    SET extraction_mode='full_text',
        baseline_id=NULL,
        latest_capture_id=NULL,
        last_percent=NULL,
        last_dimension_change=false,
        monitor_state=CASE WHEN NOT enabled THEN 'disabled' WHEN paused THEN 'paused' ELSE 'waiting_baseline' END,
        next_run=now()
    WHERE extraction_mode='product_price'
    RETURNING id
)
INSERT INTO fusion_events(monitor_id,status,configuration_changed)
  SELECT id,'extraction_transition',true FROM transitioned;
ALTER TABLE fusion_monitors
  ADD CONSTRAINT fusion_monitors_extraction_mode_check
  CHECK (extraction_mode IN ('full_text', 'selected_text'));
