# Sprint 2 implementation reference

## Browser Steps

One monitor stores an ordered `browser_steps` JSON array. One sandboxed browser context runs the steps, extracts text and takes the screenshot; no separate monitoring application or scheduler exists. SSRF checks and the pinned-IP outbound proxy remain active for every navigation/subresource.

| Action | Parameters / behavior |
| --- | --- |
| `wait_selector` | `selector`, `selector_type`; wait for attachment |
| `wait_visible` | CSS/XPath; wait for visibility |
| `click` | CSS/XPath, strict Playwright element matching |
| `dismiss_cookie` | Explicit CSS/XPath click; optionally continue on failure |
| `scroll_to` | CSS/XPath, scroll element into view |
| `scroll_by` | `x`, `y` between -5000 and 5000 pixels |
| `delay` | `duration_ms` between 0 and 5000 |
| `wait_navigation` | Exact same-origin `path`, optionally including query; wait after a preceding click, without issuing navigation |
| `select_option` | CSS/XPath and literal option `value` |
| `fill_literal` | CSS/XPath and non-sensitive literal `value` (500 characters maximum) |
| `fill_private` | CSS/XPath and vault reference `credential`; HTTPS/text-only, same-origin traffic |

All steps have `timeout_ms` (100–10000, default 5000). `continue_on_error` is restricted to wait-selector, wait-visible, scroll-to and explicit cookie-dismissal actions. Optional failures set a warning. Maximum 20 steps. `step_budget_ms` is 100–60000 (default 20000), and the global capture deadline takes precedence. Timers close stalled pages and are cleared in `finally`; browser/proxy cleanup remains mandatory after failures.

The React editor adds/removes steps and uses accessible move-up/down buttons. Changing actions clears unrelated parameters. Field validation, bounds and private-value guidance are shown inline. Literal values are visible monitor configuration: never put a secret there.

## Private form-value infrastructure

An owner can PUT `/api/v1/jobs/:id/private-values` with:

```json
{
  "values": { "account_value": "synthetic-fixture-only" },
  "expires_at": "2030-01-01T00:00:00Z"
}
```

The timestamp is illustrative; actual requests must expire in the future within 30 days. Up to 20 references, each 512 characters. PUT replaces the vault atomically, resets the baseline as a configuration change and stores only authenticated ciphertext plus reference names/expiry. GET returns names/expiry/update time only; DELETE clears material. All operations enforce monitor ownership and serialize with capture. The UI provides one-reference replacement and clearing; the API supports multiple references.

Encryption binds user, monitor and origin. Origin changes clear the vault. An expired or missing reference prevents capture and marks authentication-required. No remote browser login, cookie import, stored site session or cross-user reuse exists. Private workflows refuse visual capture and cross-origin requests. Exact values are redacted before storing extracted text; this is not general detection of all private content returned by a site. See [security boundaries](security.md).

## Account sessions

JWT `jti` identifies a PostgreSQL session row; both cookie and bearer flows check it, expiry and the active user. Logout revokes the current session. Logout-all and successful password changes revoke all that user's sessions, with user-row locks preventing login/password-change races. Other accounts remain isolated. Expired/revoked API responses return the UI to login. Tokens remain out of localStorage. Old untracked JWTs must sign in again after upgrade. Password recovery/MFA are deferred.

## Regions, baselines and attention states

Element screenshots support independent CSS/XPath selection and require exactly one visible element with usable bounded dimensions. Masks support CSS and explicit `xpath=` selectors. Viewport/full-page modes, scale/viewport/fonts/animation controls and decimal comparisons retain previous semantics. No live visual picker or remote browser preview is exposed.

Capture-affecting configuration changes (URL, selectors, steps, capture mode, normalization/masks/detection) create a reset event with `configuration_changed=true`. Historical images remain accessible. Name, schedule, threshold/channel/notification controls preserve the baseline. Threshold equality remains strictly non-alerting; dimension mismatches still have null percentage and a separate structural event.

States: healthy (first baseline), changed, unchanged, waiting-baseline, temporary-failure, persistent-failure (third consecutive failure), authentication-required, challenge-detected, paused and disabled. Metadata includes last attempt/success/change, next schedule, duration, failure count, latest capture, baseline and warning. Disabling or pausing prevents automatic/manual admission. A successful capture clears failure state; failed captures preserve valid references.

401 is confirmed authentication-required. 403 alone is access-denied. Challenge markers/interstitial titles and login-path/password-input combinations are heuristic, explicitly labeled. Ordinary articles mentioning CAPTCHA do not trigger title detection. There is no solving/bypass. Attention retries are at least 15 minutes apart, and optional alerts are deduplicated per continuous state.

## Notifications and pagination

Delivery history is owner-scoped and paginated, showing monitor/channel, pending/retrying/sending/sent/permanently-failed status, attempts, next attempt/delivery time and sanitized error. Database-backed administrators can retry their own failed deliveries using the same advisory lock and unique outbox row. Enabled channel/monitor ownership is required. Backoff is bounded exponential; five failed attempts stop automatic retries. Remote SMTP/Telegram delivery remains **at least once**, including uncertain provider-acceptance/crash windows and administrative retry.

SMTP has verified TLS and an absolute delivery deadline; Telegram has fixed-host validated TLS/deadlines. Text diff summaries use additions/deletions; attention messages and visual/dimension summaries include direct monitor links. Images larger than 4 MiB each or 8 MiB total are omitted, never cut into corrupt PNGs. One Telegram image uses sendPhoto; multiple images use an album.

`GET /jobs/:id/history?page=1&page_size=20&status=changed` returns `{items,total,page,page_size}`. Omitting `page` preserves the legacy bounded array response. `GET /deliveries?page=1&page_size=20&status=retrying` uses the envelope. Page size is limited to 100. Stable date/UUID ordering and additive indexes support offset pagination; it is not a snapshot across concurrent inserts. The dashboard adds local search/filter/name-status-last-change sorting while retaining one monitor list.

## Theme adapter

The private iOS-style selector source is unavailable. No replacement control is included.

`useThemeAdapter()` returns `{preference, resolved, setPreference}`. Preference is `light | dark | system`; resolved is `light | dark`. Only the non-sensitive preference is persisted in `fusion_theme_preference`. System changes and cross-tab storage events synchronize the provider. `themeConfig(resolved)` selects Ant Design's default/dark algorithm, and page surfaces follow the resolved theme.

A future reviewed shared-ui component should receive `value={adapter.preference}` and `onChange={adapter.setPreference}` through an adapter matching its actual source API. Review license, dependencies and compatibility before integration. Do not publish private source without permission. No component source is fetched from production.

## Migrations, worker and remaining work

Migration `003_workflows_sessions_states.sql` adds workflows/selector type, session tracking, the private vault, monitoring metadata/notification controls, attention event metadata and pagination indexes. 001/002 are unchanged. Tests cover clean installation, repeat application and upgrading an already-applied 001+002 schema while preserving baseline, legacy references and 0.35%.

PostgreSQL advisory locks, bounded worker concurrency, rootless Chromium sandbox, CPU/RAM/PID/shared-memory quotas and graceful admission/shutdown remain. Uncertain rollback/unlock destroys the connection; connections/statements/idle transactions are bounded. Artifacts are limited to 16 MiB each. Retention keeps referenced images and undelivered events. The Docker smoke runs with no external network and checks resource cgroups, Browser Steps and sandbox status.

Deferred: reviewed interactive site login/cookie/session import, MFA/single-use recovery, authenticated screenshots, a controlled visual picker, the real shared-ui selector, aggregate storage budgets, more comprehensive accessibility/performance validation, legacy artifact/provider import and operator monitoring. No external authenticated website, real provider delivery or production host was tested. See [exact validation results](validation.md).
