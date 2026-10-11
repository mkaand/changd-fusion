-- Persist only stable, safe diagnostic categories. Raw provider errors are
-- intentionally never stored because they can contain URLs or credentials.
ALTER TABLE fusion_monitors
  ADD COLUMN failure_stage text CHECK (failure_stage IS NULL OR failure_stage IN (
    'target_validation', 'browser_launch', 'browser_context', 'navigation',
    'browser_steps', 'attention_detection', 'font_wait', 'text_extraction',
    'screenshot', 'comparison', 'storage', 'database', 'unknown'
  )),
  ADD COLUMN failure_code text CHECK (failure_code IS NULL OR failure_code IN (
    'timeout', 'http_403', 'http_429', 'http_5xx', 'dns_failure',
    'connection_failure', 'tls_failure', 'egress_denied',
    'browser_launch_failed', 'browser_crashed', 'navigation_failed',
    'selector_failed', 'resource_limit', 'capture_failed', 'internal_error',
    'unknown'
  ));

ALTER TABLE fusion_events
  ADD COLUMN failure_stage text CHECK (failure_stage IS NULL OR failure_stage IN (
    'target_validation', 'browser_launch', 'browser_context', 'navigation',
    'browser_steps', 'attention_detection', 'font_wait', 'text_extraction',
    'screenshot', 'comparison', 'storage', 'database', 'unknown'
  )),
  ADD COLUMN failure_code text CHECK (failure_code IS NULL OR failure_code IN (
    'timeout', 'http_403', 'http_429', 'http_5xx', 'dns_failure',
    'connection_failure', 'tls_failure', 'egress_denied',
    'browser_launch_failed', 'browser_crashed', 'navigation_failed',
    'selector_failed', 'resource_limit', 'capture_failed', 'internal_error',
    'unknown'
  ));

CREATE INDEX fusion_monitors_failure_diagnostics
  ON fusion_monitors(failure_stage, failure_code)
  WHERE failure_stage IS NOT NULL;
