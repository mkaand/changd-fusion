# Changd Fusion

> A self-hosted Changd fork for unified text and visual website monitoring.

![Changd Fusion desktop dashboard](docs/images/dashboard-desktop.png)

Changd Fusion combines text extraction and screenshot comparison in one monitor, one browser capture, one schedule, and one combined event pipeline. It is based on [Changd by Paul Aschmann](https://github.com/paschmann/changd) and preserves the upstream project's MIT attribution while modernising the supported stack.

| Desktop dark mode | Responsive mobile dashboard |
| --- | --- |
| ![Changd Fusion dark dashboard](docs/images/dashboard-desktop-dark.png) | ![Changd Fusion mobile dashboard](docs/images/history-mobile.png) |

| Mobile monitor Advanced Settings | Mobile visual-monitor history |
| --- | --- |
| ![Changd Fusion mobile monitor editor](docs/images/capture-settings-mobile.png) | ![Changd Fusion mobile capture history](docs/images/dimensions-mobile.png) |

## Features

- **Unified monitoring** — browser text, visual, HTML and API monitoring with CSS/XPath extraction, masks, ignore rules, decimal-safe Pixelmatch comparison and structural dimension-change events. Browser text capture follows rendered visible content and excludes scripts, templates and hidden hydration state; raw HTML and API/JSON modes retain source semantics. Capture failures persist only safe stage/code categories and duration—never raw exceptions, URLs, headers, page content, or credentials. A legacy browser text baseline transitions silently on its next successful capture; its current screenshot is adopted too, so a one-time visual change is intentionally absorbed rather than notified.
- **Focused text notifications** — choose Added only, Removed only, or Added & Removed per monitor. This affects delivery only: captures, baselines, History and Timeline keep the complete change record. Visual alerts are independent of the text direction rule.
- **Optional Jina Reader source** — text-only Browser monitors may explicitly use Jina Reader. The monitored URL is sent to the third-party reader; this is shown in the editor before saving. Full Text and Product Price remain available, while Selected Text / Value lets the user inspect safe plain text and generate a bounded contextual rule for an arbitrary changing value. Ambiguous, missing, challenge, or invalid reader content fails safely and keeps the previous baseline. Chromium visual capture, Browser Steps, private values, CAPTCHA bypass and authenticated browsing are never routed through Jina.
- **Browser steps** — validated waits, clicks, scrolling, select and safe form actions run in the same sandboxed Playwright session as capture.
- **Visual history** — before/after/diff artifacts, comparison slider, pagination and retention-aware storage.
- **Smart notifications** — SMTP and Telegram channels, encrypted credentials, fixed-host TLS delivery, outbox retries, concise redacted summaries, mute/cooldown, duplicate suppression and durable monitor digests.
- **Operations** — channel validation, explicit test notifications, delivery history, monitoring defaults, bulk channel assignment and owner-scoped diagnostics.
- **Responsive interface** — a compact upstream-inspired desktop dashboard plus mobile drawer, monitor cards and safe-area layouts. The included AllMy Light/Dark/Auto control follows system preference and persists non-sensitive preference only.
- **Security** — owner checks, server-side session revocation, HttpOnly cookies, CSRF/origin validation, SSRF/DNS rebinding restrictions, sandboxed Chromium and bounded capture resources.

![Notification settings](docs/images/settings-notifications.png)

## Visual region picker

For an already saved browser/visual monitor, choose **Selected element / region** and use **Select region visually**. On mobile this opens a dedicated application page, preserving the unsaved editor form until the user returns.

![Changd Fusion mobile region picker](docs/images/region-picker-mobile.png)

The authenticated preview uses the same SSRF restrictions, pinned-IP egress proxy, and Chromium sandbox as monitoring. It reports real loading stages and uses a bounded rendering preparation step so stalled optional fonts or images do not keep the preview spinner active indefinitely. Use **+**, **−**, or pinch to zoom; drag while zoomed to pan, then click or tap a visible element. When nested boundaries are available, choose the exact element or a reasonable parent before applying the unique CSS selector. Screenshot/DOM drift is rejected instead of silently applying a mismatched selector. The selector is not saved until the monitor form is saved. The preview is short-lived and user-bound; private-value workflows are deliberately excluded. CSS/XPath entry remains available as a fallback.

For Jina Reader monitors, **Selected Text / Value** opens a dedicated safe text preview. Reader Markdown is rendered as plain text, never as remote HTML. Search the available Reader lines with case-insensitive Turkish-aware matching, select a line, refine the desired value, verify the extracted preview, and apply the server-generated contextual rule. Search results retain their original line identity. Rules contain bounded escaped context rather than executable expressions or a literal copy of the changing value; they must resolve to exactly one result on every capture. Reader previews are bounded to 2,000 safe lines and explicitly disclose when a longer response was truncated.

Chromium work is admitted through PostgreSQL session advisory leases shared by the API and worker containers. Scheduled captures receive admission priority; optional previews fail quickly with a clear capacity response instead of starting another browser tree. Preview leases include the resident owner-bound session and are released on expiry, cancellation, timeout, crash, or normal cleanup. Capture diagnostics persist only bounded numeric stage durations and stable failure categories. URLs, selectors, page content, screenshots, cookies, credentials, and raw browser exceptions are never stored in diagnostic timing fields.

## Docker self-hosting

Use Node.js 24 and PostgreSQL 16. Copy the public-safe environment example, generate independent `JWT_SECRET` and `CHANNEL_KEY` values, then start the Compose stack:

```sh
cp .env.example .env
# Set non-production example values in .env, then generate secrets locally.
docker compose up --build
```

The public UI is served through the configured same-origin frontend. PostgreSQL and API ports should remain private behind the reverse proxy. Public registration is disabled by default.

## Development and testing

```sh
cd frontend && npm ci && npm run build && npm test
cd ../server && npm ci && npm run build && npm test
# integration tests require an explicitly local disposable PostgreSQL URL
TEST_DATABASE_URL=postgresql://... PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium npm run test:integration
```

Integration tests use controlled local fixtures and mocked notification providers. They never require production accounts, real monitor targets or Telegram credentials. `UI_SCREENSHOT_DIR=docs/images` regenerates the synthetic UI screenshots used above.

## Known limitations

Remote SMTP and Telegram delivery is at-least-once: a provider can accept a message before a local status update. CAPTCHA solving, automatic authentication bypass, persistent imported site cookies and real external authenticated-site verification are deliberately not implemented. The visual picker can preview the current unsaved Browser + Visual form values through the same SSRF, TLS and sandbox restrictions; it does not offer unrestricted remote browsing.

## Upstream and license

Changd Fusion retains the [MIT License](LICENSE) and acknowledges the original Changd project and its author, Paul Aschmann. Project decisions, validation and maintenance remain the repository owner's responsibility. This project is not affiliated with or endorsed by OpenAI, ChatGPT or Codex.

Material UI changes must update the relevant README screenshots in the same development change.
