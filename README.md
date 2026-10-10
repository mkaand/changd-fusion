# Changd Fusion

Changd Fusion is a self-hosted website monitor based on [Changd by Paul Aschmann](https://github.com/paschmann/changd). It preserves Changd's Ant Design interface while bringing text and visual detection into **one monitor, one browser capture, one schedule, and one combined change event**.

## Sprint 1 / 1.1 functionality

- Node.js 24, TypeScript core, React 19, Ant Design 6, Vite, PostgreSQL 16 and sandboxed Playwright Chromium.
- Independent Text / Visual switches, CSS or XPath extraction, literal text ignore rules, whitespace/case normalization, dynamic-region removal and screenshot masks.
- Pixelmatch comparison with decimal percentages, explicit dimension-change events, before/after images, a keyboard-accessible comparison slider, highlighted text changes and filtered history.
- Viewport (default), bounded full-page and single CSS-element screenshots, with independent text extraction in the same browser session.
- HTML source and canonical JSON monitoring without launching a browser.
- Native SMTP and Telegram channels, encrypted credentials, a PostgreSQL notification outbox, retries and delivery status.
- Private screenshots, owner-scoped API operations, restricted network capture, disabled public registration, server-side sessions and sanitized errors.

This sprint does **not** claim a completed security audit or production deployment. See [security and limitations](docs/security.md) and [remaining work](docs/sprint-1.md).

## Development

Prerequisites: Node **24.19.0**, npm, PostgreSQL **16.13**, and Linux with unprivileged user namespaces for the Chromium sandbox. Each Codex Cloud task is isolated; use its existing checkout. A Git worktree is unnecessary unless explicitly requested.

```sh
cd server
npm ci
npx playwright install --with-deps chromium
cp .env.example .env
# Edit the local file with a development DATABASE_URL and independently generated keys.
# Generate JWT_SECRET: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Generate CHANNEL_KEY independently with the same command. Never commit either value.
npm run migrate
# Provide ADMIN_EMAIL and ADMIN_PASSWORD through your local environment, not command arguments.
npm run create-admin
npm run dev
# A separate terminal in server/:
npm run worker
# A separate terminal in frontend/:
npm ci
npm run dev
```

The UI uses port 3000 and proxies the API to port 8000. Authentication uses an HttpOnly, SameSite=Strict cookie; no JWT is stored in browser localStorage. `REGISTRATION_ENABLED` defaults to `false`. Existing active users retain their password hashes. SMTP and Telegram credentials are entered in authenticated channel settings, encrypted with `CHANNEL_KEY`, and never returned by the API. Keep that encryption key stable; losing it makes existing channel credentials unusable.

## Docker

```sh
cp .env.example .env
# Fill the local file with independently generated values. URL-encode special
# characters in credentials used in DATABASE_URL, or use hex-generated credentials.
docker compose build
docker compose up -d
# Securely set ADMIN_EMAIL and ADMIN_PASSWORD in the local shell, then:
docker compose run --rm -e ADMIN_EMAIL -e ADMIN_PASSWORD api node dist/create-admin.js
```

Only the UI is published, on loopback port 3000. PostgreSQL and captures use named volumes; PostgreSQL mounts `/var/lib/postgresql/data`. TLS termination is an operator responsibility, and `PUBLIC_URL` must match the browser origin. Production cookies require HTTPS. No production DNS, server or reverse-proxy settings are included here. The generic Docker Nginx configuration serves only this application.

The Docker API/worker use a version-pinned, signed Debian Chromium package with Playwright; update `CHROMIUM_VERSION` deliberately when refreshing security patches. A bundled Playwright download is optional for native development.

The worker defaults to one capture at a time (`CHROMIUM_CONCURRENCY`, bounded to 1–3 per worker) and uses PostgreSQL advisory locks across worker replicas. Its container runs as a non-root user with Chromium sandboxing enabled and the included Playwright seccomp profile. If the host blocks user namespaces, configure the runtime's supported Chromium sandbox policy; **do not disable the browser sandbox**. See [runtime requirements](docs/security.md). Optional enterprise build CAs can be supplied with Docker BuildKit's `build_ca` secret; they are mounted only during build commands, never copied into the image. Do not disable TLS or package verification.

## Baselines and precision

The first successful capture establishes the baseline without an alert. A change event compares the baseline with the latest capture; text and visual changes are combined, and a successful event advances the baseline once. Below-threshold captures update only the latest capture, allowing small visual changes to accumulate against the baseline. A failure preserves both references. Resetting or editing a monitor schedules a new baseline without deleting history.

The visual rule is **change percentage > configured threshold**. Equality does not alert, including zero at threshold zero. Pixel counts are evaluated using decimal arithmetic before persistence; PostgreSQL stores `NUMERIC(14,10)` percentages and the API returns decimal strings. Different screenshot dimensions produce a **structural dimension-change event**, independently of the percentage threshold. Its percentage is `null`, both sizes/images are preserved, no pixel diff is fabricated, and the successful new capture becomes the baseline once. The next same-sized unchanged capture does not repeat the alert.

Capture modes are Viewport (1280×900 default), Full page, and Selected element (exactly one visible CSS selector, independent of the CSS/XPath text selector). All use scale 1, a fixed viewport/locale/timezone, reduced motion, disabled animations and awaited fonts. The server checks dimensions before capture and PNG decoding; defaults allow at most 4096 pixels wide, 8192 high and 8 million total pixels, with an absolute 16-million-pixel ceiling. Oversized pages fail safely and keep both baseline/latest references. Choose a smaller region rather than accepting a silently cropped image.

Compose defaults constrain the worker to 1 CPU, 1 GiB RAM, 256 PIDs and 256 MiB shared memory. `WORKER_CPUS`, `WORKER_MEMORY`, `WORKER_PIDS`, `WORKER_SHM`, `CAPTURE_TIMEOUT_MS`, image limits and concurrency are configurable in the generic examples. Graceful shutdown stops new captures/deliveries, closes active browser/proxy resources and has a process-level deadline. Container limits remain essential because hostile pages can allocate resources before screenshot size checks.

## Notifications and persistence

SMTP requires verified TLS on port 465 or mandatory STARTTLS on 587. HTML/text messages include text summaries, decimal visual changes and available before/after/diff attachments. Telegram sends a summary with a monitor link and an image album when available. Test notifications use the same outbox as monitor events; create a monitor first, then use the channel's Test button. Its delivery appears in that monitor's history.

One unique `(event_id, channel_id)` outbox row prevents duplicate combined alerts. Delivery is **at least once**: a provider may accept a message immediately before a worker crashes, and retrying that uncertain delivery can duplicate the remote message. SMTP uses a stable Message-ID; Telegram has no general exactly-once delivery facility. This limitation is explicit rather than hidden.

`HISTORY_DAYS` defaults to 90. Cleanup keeps the current baseline/latest capture and undelivered events. Unreferenced screenshots are deleted only after a grace period. Migration runs under an advisory lock and checks applied SQL checksums. Legacy monitors/history are imported and legacy artifact references are preserved; old files, old channel credentials and optional S3 configuration are not automatically copied or exposed. Migration testing uses disposable databases; back up and review a real database separately before any later deployment.

## Validation

```sh
npm --prefix server run build
npm --prefix server test
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix frontend test
# Explicitly local, disposable PostgreSQL; tests create/drop uniquely named databases.
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres npm --prefix server run test:integration
node --test scripts/privacy-scan.test.mjs
node scripts/privacy-scan.mjs --history=origin/master
```

Integration tests need the frontend build and Playwright browser. `PLAYWRIGHT_EXECUTABLE_PATH` can select a compatible installed Chromium. Tests use controlled local fixtures and mocked notification providers, never real monitoring targets or production accounts. CI pins a supported sandbox-compatible Ubuntu 22.04 runner, runs builds, audits, unit/integration tests and browser smoke checks, and has an independent history/privacy job. Integration tests report failures immediately (TAP), have 90-second test deadlines and an 8-minute process-group watchdog; the verification job is bounded to 20 minutes. The artifact/source privacy scan also runs after test failure. Set `UI_SCREENSHOT_DIR` to an ignored local directory to retain synthetic dashboard/history/settings screenshots for review. See [Sprint 1.1 validation](docs/validation.md).

## Theme integration

`frontend/src/theme.ts` is the integration boundary for the repository owner's established shared-ui design. The private Light/Dark/System source has not been supplied. The exact switch and theme adaptation remain pending; no imitation is presented as that design.

## Attribution and AI-assisted development

Changd Fusion retains the original **MIT license and Paul Aschmann attribution**. The February 2026 visual-precision ideas associated with [Dannyzimmer/changd](https://github.com/Dannyzimmer/changd) informed the requested semantics; this implementation is independent and does not modify that repository.

Development is assisted by **OpenAI ChatGPT** and **OpenAI Codex**. Project decisions, validation, code review and ongoing maintenance remain the repository owner's responsibility. This project is not officially affiliated with or endorsed by OpenAI. See [CONTRIBUTING.md](CONTRIBUTING.md).
