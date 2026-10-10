-- Additive Sprint 2 migration; 001 and 002 remain immutable.
ALTER TABLE fusion_monitors
 ADD COLUMN browser_steps jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(browser_steps)='array' AND jsonb_array_length(browser_steps)<=20),
 ADD COLUMN step_budget_ms integer NOT NULL DEFAULT 20000 CHECK(step_budget_ms BETWEEN 100 AND 60000),
 ADD COLUMN capture_selector_type text NOT NULL DEFAULT 'css' CHECK(capture_selector_type IN ('css','xpath')),
 ADD COLUMN paused boolean NOT NULL DEFAULT false,
 ADD COLUMN monitor_state text NOT NULL DEFAULT 'waiting_baseline' CHECK(monitor_state IN ('healthy','changed','unchanged','waiting_baseline','temporary_failure','persistent_failure','authentication_required','challenge_detected','paused','disabled')),
 ADD COLUMN last_success_at timestamptz,
 ADD COLUMN last_change_at timestamptz,
 ADD COLUMN execution_ms integer,
 ADD COLUMN warning_code text,
 ADD COLUMN notify_failures boolean NOT NULL DEFAULT false,
 ADD COLUMN notify_attention boolean NOT NULL DEFAULT false;
UPDATE fusion_monitors SET monitor_state=CASE WHEN NOT enabled THEN 'disabled' WHEN failure_count>=3 THEN 'persistent_failure' WHEN failure_count>0 THEN 'temporary_failure' WHEN baseline_id IS NOT NULL THEN 'healthy' ELSE 'waiting_baseline' END,
 last_success_at=CASE WHEN failure_count=0 AND latest_capture_id IS NOT NULL THEN last_run ELSE NULL END;
ALTER TABLE fusion_events ADD COLUMN attention_state text, ADD COLUMN warning_code text, ADD COLUMN execution_ms integer, ADD COLUMN configuration_changed boolean NOT NULL DEFAULT false;
CREATE INDEX fusion_history_pagination ON fusion_events(monitor_id,created_at DESC,id DESC);
CREATE TABLE fusion_sessions (
 id uuid PRIMARY KEY, user_id varchar NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fusion_sessions_user ON fusion_sessions(user_id) WHERE revoked_at IS NULL;
-- Write-only private form values. No remote browser login or shared cookie store.
CREATE TABLE fusion_monitor_vault (
 monitor_id uuid PRIMARY KEY REFERENCES fusion_monitors(id) ON DELETE CASCADE,
 user_id varchar NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
 origin text NOT NULL, encrypted text NOT NULL, value_names jsonb NOT NULL,
 expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fusion_delivery_history ON fusion_outbox(channel_id,next_attempt DESC,id DESC);
