# Sprint 2 validation

Executed on 2026-10-10 in isolated Codex Cloud with synthetic accounts, controlled local endpoints and disposable PostgreSQL databases. No production system or real provider credential was used.

| Check | Result |
| --- | --- |
| Backend TypeScript production build | Passed |
| Frontend TypeScript + Vite production build | Passed; largest JS chunk about 452 KB, no large-chunk warning |
| Backend unit/security/provider/coordination/workflow tests | 30 passed, zero failures/skips |
| PostgreSQL integration and real Chromium browser tests | 24 passed, zero failures/skips |
| Frontend login, precision, comparison, history, steps, delivery/theme/API tests | 18 passed, zero failures/skips |
| Privacy scanner regression tests | 2 passed, zero failures/skips |
| Full npm audits, both packages including development dependencies | Zero reported vulnerabilities at validation time |
| Source/build tree and new commit-history privacy scan | Passed within scanner scope, with manual domain/infrastructure review |
| API and UI Docker production builds | Passed |
| Compose configuration validation | Passed |
| Docker UID / CPU / RAM / PID cgroup limits | UID 1000; 1 CPU, 1 GiB, 256 PIDs verified |
| Docker sandbox and capture-mode smoke | Browser Steps and CSS/XPath viewport/full-page/element hybrid captures passed; Chromium reported Seccomp-BPF sandbox enabled |
| Docker migration / worker shutdown | Migration 003 applied on disposable DB; idle worker established DB coordination and exited 0 on SIGTERM |
| Complete current Compose startup in Cloud | Not completed: concurrent image/container allocation exceeded this 32 GiB Cloud disk; components tested sequentially |
| Original MIT license and migrations 001/002 | Unchanged |
| Real SMTP / Telegram delivery | Not attempted; mocked providers/outbox tested |

GitHub verification runs the same suites using the bundled Playwright Chromium on a pinned Ubuntu 22.04 runner. Check draft PR #1 for the final-head workflow status; a cancelled, partial or diagnostic run is not a passing validation. Sprint 2 implementation run [38034723359](https://github.com/mkaand/changd-fusion/actions/runs/38034723359) and push run [38034720087](https://github.com/mkaand/changd-fusion/actions/runs/38034720087) completed successfully with verify/privacy/docker jobs. The PR and final report link the latest final-head run after this documentation update. The previous Sprint 1.1 baseline was [38031604802](https://github.com/mkaand/changd-fusion/actions/runs/38031604802), with 46 passing tests. Sprint 2 expands this to **74 passing tests**, zero skipped/cancelled/failed tests, plus Docker smoke checks.

## CI incident and repair

Original run [38005493269](https://github.com/mkaand/changd-fusion/actions/runs/38005493269) reported two immediate browser-test failures but never emitted the final failure details. The spec reporter buffered those details until suite completion. The UI fixture launched Chromium outside `try/finally`; launch failure left the API/UI HTTP servers listening, so the Node test process could not exit. With no shorter test/job limits, GitHub cancelled it at its default six-hour maximum, before the privacy step.

A bounded reproduction using the same browser version on Ubuntu 24.04 produced `No usable sandbox`, explicitly identifying AppArmor user-namespace restrictions. The Ubuntu 22.04 verification job passed with `chromiumSandbox: true`. The temporary diagnostic job was then removed. No sandbox fallback, global AppArmor disablement or permissive sysctl was introduced.

Tests now register fixture cleanup during setup and use `try/finally` for browsers, proxy sockets, gates and disposable databases. Active HTTP connections are closed. TAP emits failure details immediately. Individual integration tests have 90-second deadlines, the process-group watchdog has an 8-minute deadline with forced cleanup, the integration step has 10 minutes, and the verification job has 20 minutes. An independent three-minute privacy job scans source and new history even if installs/browser tests fail; build artifacts are also scanned with `if: always()` in verification.

## Behavior verified

- The exact `0.35%` path remains comparison → PostgreSQL NUMERIC → authenticated API → browser display → mocked notification. Zero, tiny, equality and genuine 100% comparisons remain covered; the rule is still strictly greater than the threshold.
- Dimension mismatches store `null` percentage, explicit old/new sizes and both images. They produce one structural combined event/outbox entry, advance the baseline once and do not repeat for the next unchanged capture. Notification templates explain the condition rather than inventing a percentage.
- Viewport/full-page/element capture extracts text and image from the same page. Oversized pages, missing selectors, launch failures and navigation timeouts fail safely, preserve baseline/latest references and clean up browser/proxy/fixture resources.
- Migration testing reconstructs an already-applied Sprint 1 migration/checksum with a baseline/latest capture and decimal value, then preserves applied migrations 001+002 and applies migration 003 repeatedly without changing those references. Original legacy history/artifact references also survive.
- Worker concurrency, same-monitor advisory locks, shutdown admission, outbox retry/restart uniqueness, and failed database-unlock cleanup are covered. Uncertain unlocks destroy the session rather than return a potentially locked connection to the pool.
- Ownership, JWT/admin authority, mutation origin/header, disabled registration, SSRF/private IP/DNS/redirect/subresource restrictions, TLS validation, encryption and artifact path containment remain covered.
- Browser smoke checks login, 0.35% history, slider keyboard interaction, mobile page bounds, dimension presentation and capture settings. Synthetic dashboard/history/dimension/settings screenshots are retained only in ignored local test output when `UI_SCREENSHOT_DIR` is set.

Intermediate defects found and repaired during this sprint include the missing jsdom ResizeObserver fixture, inaccurate deletion-status assumptions in new tests, and an aggressive Ant Design vendor split that caused a runtime initialization error. The final split keeps React together, uses lazy history/channel routes, and passes real browser tests. Responsive assertions wait for the actual collapsed-layout condition rather than guessing a delay. No failing test is disabled.

## Sprint 2 verification

- Ordered Browser Steps exercise cookie dismissal, dropdown selection, literal/private fill, CSS/XPath waits, scrolling, deadlines, safe optional warnings and sanitized errors. Real Chromium verifies the public workflow before one hybrid capture. A stalled scroll evaluation is interrupted by its step deadline.
- Revoked cookie/bearer tokens cannot be reused after logout/all-devices/password change. Expired, unknown, untracked and cross-user session IDs fail. Incorrect current-password attempts do not revoke a valid session.
- Vault ownership, write-only responses, encryption binding/tamper protection, reference isolation/expiry and clear operations are covered. Private-fill execution uses controlled pages/mocks; no real authenticated HTTPS site login was attempted or claimed.
- Controlled 401/403/login/challenge fixtures preserve safe distinctions, including avoiding a false positive on an article about CAPTCHA. State transitions preserve captures, metadata/backoff are persisted, and continuous persistent/challenge states produce one optional alert.
- Pagination, baseline configuration resets, paused scheduling, owner-scoped delivery history, administrator retry and permanent failure after five bounded retries are verified.
- React tests cover step add/remove/reorder/validation, search/status semantics, delivery error/retry UI, theme storage/algorithm synchronization and revoked-session handling. Browser smoke additionally exercises dashboard search, mobile steps controls, decimal history and image comparisons; ignored local screenshots include `browser-steps-mobile.png`.
- Production Docker API/UI builds pass. The reusable `scripts/docker-smoke.mjs` checks UID 1000, 1 CPU, 1 GiB RAM, 256 PIDs and sandboxed Browser Steps/CSS/XPath captures with no external container network. CI adds a separate bounded Ubuntu 22.04 Docker job.

During local verification, the 32 GiB Cloud disk filled with Docker build layers and a smoke launch failed with ENOSPC. Reclaiming only this application's reproducible build cache and superseded disposable validation images/containers restored space; database/capture volumes were preserved. The final image smoke was rerun successfully. The complete current Compose stack could not be kept concurrently on this Cloud disk; configuration, migration, worker shutdown, image builds and sandboxed captures were checked separately. GitHub Docker builds/smoke also passed. No sandbox/security setting was relaxed. The frontend's jsdom pseudo-element layout notice is informational; real Chromium checks the rendered interface. No test is disabled or skipped.

## Limits

Total JavaScript download size is not reduced by the same ratio as the largest chunk; initial dependencies remain significant. Further route/form optimization and performance budgets remain future work. New delivery/account/private-value views are lazy-loaded; there is no claim that total JavaScript shrank. The private shared-ui theme source is still unavailable and no substitute is introduced.

Image checks cannot prevent a hostile page from allocating resources before measurement; Docker quotas provide the tested process-level backstop. Sandbox policy on a future deployment host requires a separately authorized review. Previously stored Sprint 1 dimension mismatches cannot safely be retroactively distinguished from genuine 100% events without inspecting historical artifacts, so old records are not rewritten.

Remote notifications remain at least once in crash/uncertain-provider windows. The scanner checks known credential patterns, emails and optionally supplied private substrings; it is not a complete security audit. Runtime configuration, screenshots, credentials and logs are ignored and excluded from commits/build contexts. Inherited upstream history is preserved; new changed commit files are scanned without printing matched values.
