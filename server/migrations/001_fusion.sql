CREATE TABLE IF NOT EXISTS users (
 user_id varchar PRIMARY KEY DEFAULT gen_random_uuid()::text,
 firstname varchar NOT NULL DEFAULT '', lastname varchar NOT NULL DEFAULT '',
 email varchar NOT NULL UNIQUE, password varchar NOT NULL, user_type integer NOT NULL DEFAULT 0,
 status integer NOT NULL DEFAULT 1, date_created timestamptz NOT NULL DEFAULT now(), last_login timestamptz
);
-- Legacy installations use integer percentages. Never round during comparison.
DO $$ BEGIN
 IF to_regclass('public.jobs') IS NOT NULL THEN
  ALTER TABLE jobs ALTER COLUMN diff_percent TYPE numeric(14,10), ALTER COLUMN latest_diff_percent TYPE numeric(14,10);
  ALTER TABLE history ALTER COLUMN change_percent TYPE numeric(14,10);
 END IF;
END $$;
CREATE TABLE fusion_monitors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id varchar NOT NULL REFERENCES users(user_id),
 name text NOT NULL, url text NOT NULL, kind text NOT NULL CHECK(kind IN ('browser','html','api')),
 text_enabled boolean NOT NULL DEFAULT true, visual_enabled boolean NOT NULL DEFAULT false,
 selector text NOT NULL DEFAULT '', selector_type text NOT NULL DEFAULT 'css' CHECK(selector_type IN ('css','xpath')),
 ignore_selectors jsonb NOT NULL DEFAULT '[]', ignore_text jsonb NOT NULL DEFAULT '[]', mask_selectors jsonb NOT NULL DEFAULT '[]',
 normalize_whitespace boolean NOT NULL DEFAULT true, ignore_case boolean NOT NULL DEFAULT false,
 visual_threshold numeric(14,10) NOT NULL DEFAULT 0.35 CHECK(visual_threshold BETWEEN 0 AND 100),
 pixel_threshold numeric(4,3) NOT NULL DEFAULT 0.1 CHECK(pixel_threshold BETWEEN 0 AND 1),
 interval_seconds integer NOT NULL DEFAULT 300 CHECK(interval_seconds BETWEEN 30 AND 604800),
 enabled boolean NOT NULL DEFAULT true, baseline_id uuid, latest_capture_id uuid,
 last_percent numeric(14,10), last_run timestamptz, next_run timestamptz NOT NULL DEFAULT now(),
 failure_count integer NOT NULL DEFAULT 0, last_error text, legacy_job_id integer UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(text_enabled OR visual_enabled),
 CHECK(kind = 'browser' OR (text_enabled AND NOT visual_enabled))
);
CREATE INDEX fusion_due ON fusion_monitors(next_run) WHERE enabled;
CREATE TABLE fusion_captures (
 id uuid PRIMARY KEY, monitor_id uuid NOT NULL REFERENCES fusion_monitors(id) ON DELETE CASCADE,
 text_content text, screenshot text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fusion_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), monitor_id uuid NOT NULL REFERENCES fusion_monitors(id) ON DELETE CASCADE,
 before_id uuid REFERENCES fusion_captures(id) ON DELETE RESTRICT, after_id uuid REFERENCES fusion_captures(id) ON DELETE RESTRICT,
 text_changed boolean NOT NULL DEFAULT false, visual_changed boolean NOT NULL DEFAULT false,
 visual_percent numeric(14,10), diff_screenshot text, text_diff jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL CHECK(status IN ('baseline','unchanged','changed','failed','reset','legacy','test')),
 error text, legacy_refs jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fusion_history ON fusion_events(monitor_id,created_at DESC);
CREATE TABLE fusion_channels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id varchar NOT NULL REFERENCES users(user_id),
 name text NOT NULL, provider text NOT NULL CHECK(provider IN ('smtp','telegram')),
 config jsonb NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fusion_monitor_channels (
 monitor_id uuid NOT NULL REFERENCES fusion_monitors(id) ON DELETE CASCADE,
 channel_id uuid NOT NULL REFERENCES fusion_channels(id) ON DELETE CASCADE, PRIMARY KEY(monitor_id,channel_id)
);
CREATE TABLE fusion_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES fusion_events(id) ON DELETE CASCADE,
 channel_id uuid NOT NULL REFERENCES fusion_channels(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed')),
 attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(),
 delivered_at timestamptz, last_error text, UNIQUE(event_id,channel_id)
);
CREATE INDEX fusion_outbox_due ON fusion_outbox(next_attempt) WHERE status IN ('pending','sending');
-- Preserve legacy monitors and history without invoking legacy code or changing old baselines.
DO $$ BEGIN
 IF to_regclass('public.jobs') IS NOT NULL THEN
  INSERT INTO fusion_monitors(user_id,name,url,kind,text_enabled,visual_enabled,selector,selector_type,visual_threshold,interval_seconds,enabled,legacy_job_id)
  SELECT j.user_id,j.job_name,j.url,CASE j.job_type WHEN 2 THEN 'api' WHEN 3 THEN 'html' ELSE 'browser' END,
   j.job_type<>0,j.job_type=0,coalesce(j.xpath,''),'xpath',coalesce(j.diff_percent,5),
   greatest(30,least(604800,j.frequency*60)),j.status=1,j.job_id
  FROM jobs j JOIN users u ON u.user_id=j.user_id WHERE j.url IS NOT NULL;
  INSERT INTO fusion_events(id,monitor_id,status,visual_percent,legacy_refs,created_at)
  SELECT h.history_id::uuid,m.id,'legacy',h.change_percent,
   jsonb_build_object('screenshot',h.screenshot,'source_screenshot',h.source_screenshot,'diff_screenshot',h.diff_screenshot,
   'source_response',h.source_response,'response',h.response,'diff_response',h.diff_response),h.datetime
  FROM history h JOIN fusion_monitors m ON m.legacy_job_id=h.job_id;
 END IF;
END $$;
