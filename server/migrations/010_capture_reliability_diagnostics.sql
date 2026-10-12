-- Numeric-only capture stage timings make deadline failures diagnosable
-- without persisting URLs, selectors, page content, or provider errors.
ALTER TABLE fusion_monitors
  DROP CONSTRAINT fusion_monitors_failure_stage_check,
  DROP CONSTRAINT fusion_monitors_failure_code_check,
  ADD CONSTRAINT fusion_monitors_failure_stage_check CHECK (failure_stage IS NULL OR failure_stage IN (
    'target_validation', 'proxy_initialization', 'browser_launch', 'browser_context',
    'navigation', 'browser_steps', 'attention_detection', 'font_wait',
    'text_extraction', 'screenshot', 'selector_lookup', 'visibility_validation',
    'scroll_into_view', 'element_stability', 'screenshot_rasterization',
    'image_validation', 'cleanup', 'comparison', 'storage', 'database', 'unknown'
  )),
  ADD CONSTRAINT fusion_monitors_failure_code_check CHECK (failure_code IS NULL OR failure_code IN (
    'timeout', 'http_403', 'http_429', 'http_5xx', 'dns_failure',
    'connection_failure', 'tls_failure', 'egress_denied', 'browser_launch_failed',
    'browser_crashed', 'navigation_failed', 'selector_failed', 'selector_missing',
    'selector_ambiguous', 'element_not_visible', 'element_unstable',
    'screenshot_timeout', 'capacity_busy', 'resource_limit', 'capture_failed',
    'internal_error', 'unknown'
  )),
  ADD COLUMN last_capture_timings jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE fusion_events
  DROP CONSTRAINT fusion_events_failure_stage_check,
  DROP CONSTRAINT fusion_events_failure_code_check,
  ADD CONSTRAINT fusion_events_failure_stage_check CHECK (failure_stage IS NULL OR failure_stage IN (
    'target_validation', 'proxy_initialization', 'browser_launch', 'browser_context',
    'navigation', 'browser_steps', 'attention_detection', 'font_wait',
    'text_extraction', 'screenshot', 'selector_lookup', 'visibility_validation',
    'scroll_into_view', 'element_stability', 'screenshot_rasterization',
    'image_validation', 'cleanup', 'comparison', 'storage', 'database', 'unknown'
  )),
  ADD CONSTRAINT fusion_events_failure_code_check CHECK (failure_code IS NULL OR failure_code IN (
    'timeout', 'http_403', 'http_429', 'http_5xx', 'dns_failure',
    'connection_failure', 'tls_failure', 'egress_denied', 'browser_launch_failed',
    'browser_crashed', 'navigation_failed', 'selector_failed', 'selector_missing',
    'selector_ambiguous', 'element_not_visible', 'element_unstable',
    'screenshot_timeout', 'capacity_busy', 'resource_limit', 'capture_failed',
    'internal_error', 'unknown'
  )),
  ADD COLUMN capture_timings jsonb NOT NULL DEFAULT '{}'::jsonb;
