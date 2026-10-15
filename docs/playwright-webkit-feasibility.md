# Playwright WebKit feasibility audit

## Scope

This is a pre-integration audit for an experimental Playwright WebKit capture
engine. No engine selector, browser download, Docker image change, schema
change, or runtime fallback is included while the baseline-transition blocker
below remains unresolved.

Changd Fusion currently pins Playwright at `1.64.0`. The checked-in runtime
only provisions system Chromium; a reproducible WebKit browser bundle and its
Linux dependencies have not been added.

## Current capture contract

The current browser path creates one Playwright context with a fixed
`1280 x 900` viewport and scale 1. It routes the browser through Changd's local
pinned-IP proxy, applies Browser Steps, extracts text, disables animations,
and creates every screenshot from that same page. It validates element
visibility/stability, CSS/XPath selection, masks, PNG dimensions, deadlines,
and cleanup before returning the existing capture result contract.

## WebKit API compatibility review

| Capability | Audit result | Notes |
| --- | --- | --- |
| Playwright launch proxy | Supported by type/API surface | Playwright's generic launch options accept an HTTP/SOCKS proxy. A future implementation must prove WebKit routes navigation, redirects, subresources, and WebSockets through Changd's proxy in an isolated integration test. |
| TLS validation | Supported by intended context settings | A WebKit context can retain `ignoreHTTPSErrors: false`; it must never be changed. |
| JavaScript, CSS, Browser Steps | Expected compatible | They use Playwright `Page`/`Locator` APIs. Must be tested with WebKit rather than assumed. |
| CSS and XPath selection | Expected compatible | Existing `locate()` and `xpath=` locator paths are portable Playwright APIs; element/actionability behavior can differ and needs fixture coverage. |
| Viewport/full-page/element screenshots | Available | Use `page.screenshot()` / locator-based or clip-based native APIs. Chromium CDP `Page.captureScreenshot` is Chromium-only and cannot be reused. |
| Screenshot masks | Expected compatible | Playwright screenshot masks are public screenshot options; WebKit support must be verified in the pinned browser build. |
| Same-session text and image | Available by design | A future adapter can retain one WebKit page for both operations. |
| Chromium CDP fast path | Unsupported | The existing CDP viewport/clip implementation cannot run under WebKit. |
| Chromium sandbox switch | Unsupported | `chromiumSandbox` is Chromium-specific. WebKit must not cause a weaker container, seccomp, UID, PID, CPU, or memory policy. Its actual Linux process/security behavior needs a pinned-image integration test. |
| Region Picker | Not yet verified | It currently uses Chromium/CDP and needs an explicit WebKit-capable implementation or an intentionally separate, correctly labeled preview path. |

## Egress/security gate

The existing proxy is independent of Chromium and can be passed through
Playwright's generic proxy launch option. That is promising, but source/type
inspection is not proof of network equivalence. Before any WebKit adapter is
allowed, a pinned WebKit integration environment must prove all of the
following with synthetic endpoints:

- navigation, redirects, subresources, and WebSockets reach only the
  `browserProxy` path;
- private and rebinding targets are rejected at connection time;
- TLS verification remains enabled;
- private-value workflow restrictions remain text-only, HTTPS-only, and
  same-origin;
- cancellation closes the WebKit process tree without orphan processes;
- the current rootless Docker limits and security policy remain intact.

No such WebKit runtime is currently provisioned, so these items are unverified,
not passed.

## Blocking baseline-transition requirement

The requested transition must distinguish a Chromium visual baseline from a
WebKit visual baseline persistently for every monitor. The current schema only
stores `baseline_id` and `latest_capture_id`; neither identifies the rendering
engine. `browser_text_extraction_version` is specifically about legacy text
extraction, and `last_capture_timings` is bounded diagnostic JSON, not durable
baseline-transition state.

Using capture filenames, timing JSON, application version, or an in-memory
flag would be a fragile heuristic. It could silently rebaseline repeatedly,
emit false Telegram notifications after restart/rollback, or fail to rebaseline
when the engine actually changes. That would violate the requested no-false-
alert and immediate-rollback requirements.

The minimum reliable design requires a new, separately approved migration that
adds a monitor-level visual-baseline engine marker (for example
`visual_baseline_engine` constrained to `chromium` / `webkit`, nullable for
legacy rows). The successful capture transaction would atomically:

1. compare the configured engine to the persisted visual-baseline engine;
2. on a changed engine and a complete valid visual capture, adopt only the
   visual baseline, preserve the text baseline, write an explicit transition
   event/state without outbox delivery, and persist the marker;
3. leave the marker and baseline untouched on failures/partial captures;
4. perform the same controlled transition when returning to Chromium.

This is an additive migration, but it is still a migration. It was not
authorized for this task, so implementation stops here.

## Future production trial design (not executed)

### Stage A: isolated validation

Run a pinned WebKit image in a separate environment with the same application
version and a sanitized copy of monitor configuration. Disable all notification
delivery and run exactly one scheduler against its own database. Benchmark
synthetic and approved staging fixtures against Chromium and WebKit with cold
and warm samples, recording total/navigation/screenshot duration, p95, RSS,
CPU, PNG dimensions, pixel differences, timeout rate, and process cleanup.

### Stage B: separately approved production trial

Only after the migration, egress tests, and Stage A pass, explicitly select the
engine in the deployment configuration for one controlled application instance.
Do not run a competing scheduler, do not create a second monitor collection,
and preserve current database plus capture-volume backups. The first complete
visual capture of each monitor performs the transactionally recorded silent
transition. Rollback selects Chromium and performs the equivalent one-time
silent visual rebaseline. Production automation following `master` must not be
bypassed; this needs a separately reviewed deployment mechanism.

No production access, deployment, database action, or environment change was
performed by this audit.
