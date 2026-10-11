# Changd Fusion

> A self-hosted Changd fork for unified text and visual website monitoring.

![Changd Fusion desktop dashboard](docs/images/dashboard-desktop.png)

Changd Fusion combines text extraction and screenshot comparison in one monitor, one browser capture, one schedule, and one combined event pipeline. It is based on [Changd by Paul Aschmann](https://github.com/paschmann/changd) and preserves the upstream project's MIT attribution while modernising the supported stack.

| Desktop dark mode | Responsive mobile dashboard |
| --- | --- |
| ![Changd Fusion dark dashboard](docs/images/dashboard-desktop-dark.png) | ![Changd Fusion mobile dashboard](docs/images/history-mobile.png) |

## Features

- **Unified monitoring** — browser text, visual, HTML and API monitoring with CSS/XPath extraction, masks, ignore rules, decimal-safe Pixelmatch comparison and structural dimension-change events. Browser text capture follows rendered visible content and excludes scripts, templates and hidden hydration state; raw HTML and API/JSON modes retain source semantics.
- **Browser steps** — validated waits, clicks, scrolling, select and safe form actions run in the same sandboxed Playwright session as capture.
- **Visual history** — before/after/diff artifacts, comparison slider, pagination and retention-aware storage.
- **Smart notifications** — SMTP and Telegram channels, encrypted credentials, fixed-host TLS delivery, outbox retries, concise redacted summaries, mute/cooldown, duplicate suppression and durable monitor digests.
- **Operations** — channel validation, explicit test notifications, delivery history, monitoring defaults, bulk channel assignment and owner-scoped diagnostics.
- **Responsive interface** — a compact upstream-inspired desktop dashboard plus mobile drawer, monitor cards and safe-area layouts. The included AllMy Light/Dark/Auto control follows system preference and persists non-sensitive preference only.
- **Security** — owner checks, server-side session revocation, HttpOnly cookies, CSRF/origin validation, SSRF/DNS rebinding restrictions, sandboxed Chromium and bounded capture resources.

![Notification settings](docs/images/settings-notifications.png)

## Visual region picker

For an already saved browser/visual monitor, choose **Selected element / region** and use **Select region visually**. The authenticated preview uses the same SSRF restrictions and Chromium sandbox as monitoring. Clicking a visible region proposes a unique CSS selector; it is not saved until the monitor form is saved. Private-value workflows are deliberately excluded from preview. CSS/XPath entry remains available as a fallback.

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

Remote SMTP and Telegram delivery is at-least-once: a provider can accept a message before a local status update. CAPTCHA solving, automatic authentication bypass, persistent imported site cookies and real external authenticated-site verification are deliberately not implemented. The visual picker is available after a monitor is saved; it does not offer unrestricted remote browsing.

## Upstream and license

Changd Fusion retains the [MIT License](LICENSE) and acknowledges the original Changd project and its author, Paul Aschmann. Project decisions, validation and maintenance remain the repository owner's responsibility. This project is not affiliated with or endorsed by OpenAI, ChatGPT or Codex.

Material UI changes must update the relevant README screenshots in the same development change.
