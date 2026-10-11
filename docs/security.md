# Security boundaries

## Verified changes

- The legacy server/routes/daemon implementation is retired, including its unauthenticated scheduler endpoint and filesystem screenshot route.
- JWT verification requires HS256, expiration, issuer, audience and a server-tracked session ID. Cookie and bearer tokens are rejected after logout, logout-all, password changes, expiry or account deactivation. Session creation and password changes serialize on the user row. Identity and administrator authority are checked against the active user record on each request; token role claims do not grant administrator privileges.
- All monitor mutation/read/history/artifact operations and channel operations enforce ownership. Channel associations and test notifications also require ownership of both resources.
- SQL values are parameterized. Dynamic monitor field names come only from a strict schema whitelist.
- Cookie sessions are HttpOnly and SameSite=Strict. Mutations need a custom header and an allowed Origin. There is no permissive CORS policy. Production cookies require HTTPS.
- Requests are size limited and rate limited. Password hashing uses bcrypt; public registration is disabled by default. Structured logs contain request IDs/status codes, not bodies, credentials, URLs or stack traces. API/capture/provider failures are sanitized.
- SMTP requires certificate verification and TLS; notification credentials are AES-256-GCM encrypted at rest. Operators must protect the master key and database backups.
- Screenshot names are generated UUIDs, checked against database ownership and resolved within the storage root. Symlink escapes and traversal are rejected; artifacts are served privately without caching.

## Network capture

Only HTTP/HTTPS and ports 80/443 are accepted for monitoring. URL credentials, local names and private/special-use addresses, including IPv4-mapped IPv6 and metadata addresses, are blocked. Every resolved address must be public. DNS resolution is bounded. HTTP/JSON connects to the validated IP with the original hostname preserved for TLS verification, and every redirect is revalidated. Response sizes and timeouts are bounded.

Playwright uses an ephemeral local forward proxy. The proxy independently resolves, validates and pins the destination when opening the TCP connection, closing the DNS-rebinding gap in a route-only design. All browser traffic uses that proxy, with loopback bypass disabled. Routes also validate destinations; service workers, downloads and WebSockets are disabled. Chromium's sandbox is enabled; no `--no-sandbox`, disabled web security, ignored certificate errors or CAPTCHA services are used.

SMTP destinations undergo public DNS validation and connect to the validated IP; TLS servername remains the configured hostname. Telegram uses only the fixed Bot API hostname with certificate verification. Neither provider is exercised with real credentials during tests.

This is application-level egress protection. Network-layer outbound filtering provides defense in depth and remains an operator responsibility. Browser vulnerabilities, complex DNS/platform behavior and resource exhaustion still require review. This sprint is not a penetration test or a complete security certification.

## Runtime requirements

The sandbox needs unprivileged user namespaces and sufficient shared memory. The default Cloud Docker seccomp policy initially denied namespace creation; the official Playwright profile enabled a successful non-root, sandboxed capture. Containers run the worker as `node`, with `init: true`, configurable CPU/RAM/PID limits and 256 MiB shared memory by default. Native CI pins Ubuntu 22.04; reproducing the old Ubuntu 24.04 runner produced Chromium `No usable sandbox` under its AppArmor user-namespace policy. No global AppArmor/sysctl relaxation or unsandboxed fallback is used. The included seccomp profile is the Playwright project's Docker profile, allowing the namespace syscalls Chromium requires while retaining syscall filtering. Some hosts' AppArmor or kernel policies still prevent sandbox startup; use a reviewed runtime policy compatible with Chromium namespaces. The application deliberately fails captures safely in that environment rather than falling back to unsandboxed Chromium. Runtime sandbox policy validation must be performed on the intended deployment host in a separate authorized task.

The included Compose configuration is generic development/build material. No production host, DNS or external reverse-proxy changes are performed. HTTP production deployment is unsupported because secure cookies require TLS. A reverse proxy must preserve the configured origin. The API does not trust arbitrary forwarded IP headers; default rate limiting behind a proxy shares its bucket across clients.

## Known limits

- JWTs last two hours and are revocable. Existing pre-migration JWTs require reauthentication. MFA and single-use account recovery remain deferred; the insecure legacy reset flow stays removed. Revocation blocks subsequent requests, not an operation already authorized and running.
- Providers can accept delivery before a local status commit. Retries have at-least-once semantics; exactly-once remote notifications cannot be promised. A permanently failed row is retained for investigation.
- HTML source monitoring uses a bounded HTTP fetch. It does not render JavaScript; choose Browser monitoring for DOM extraction.
- Viewport/full-page/element screenshots have dimension/pixel/time limits and Compose CPU/RAM/PID limits. Hostile content can still consume resources before the preflight check; quotas and concurrency must be reviewed for the target host. Persistent authenticated-site cookies, broader accessibility coverage and operational metrics remain future work.
- Existing S3 storage and legacy arbitrary Reach providers are not migrated into the new runtime. Legacy history references remain in PostgreSQL; a reviewed artifact/channel import tool is pending.
- This sprint does not migrate production data, rotate production secrets or deploy containers.

## Sprint 2 workflow and vault boundaries

Browser Steps are a strict discriminated action schema, at most 20 steps, at most 10 seconds per step and at most 60 seconds per workflow, always bounded by the capture deadline. Only optional waits, scroll-to and explicit cookie dismissal can continue on error. User JavaScript, shell commands, browser debug endpoints and arbitrary navigation actions are not accepted. Fixed application code implements bounded scrolling; it is not a user-script facility. Step errors show action/index only, not selectors, field values or browser exceptions.

The private form-value vault is write-only and separate from monitor API records. AES-256-GCM binds ciphertext to user, monitor and origin as authenticated additional data; keys are namespaced per monitor. Values expire within 30 days, can be cleared and are never returned in API responses. The existing `CHANNEL_KEY` also protects this vault; protect it separately from database access. Origin changes discard the vault. No cookies or persistent browser storage are imported or shared. Every capture creates a fresh context.

Private steps require HTTPS and text-only capture. In addition to public-IP/DNS/proxy checks, the browser denies cross-origin traffic in private workflows, including redirects and subresources. This can block third-party sign-in/CDN workflows. Exact supplied private values are replaced before text normalization/persistence; screenshot capture is refused, avoiding a misleading promise that masks can redact arbitrary authenticated content. Do not treat exact-value redaction as a general DLP guarantee: a website can transform or disclose additional private account information. The owner must select only intended, legitimate sites and extraction regions.

Encrypted storage, binding, API ownership, expiry and private-fill execution are covered separately with mocks/controlled pages. A real external authenticated login was not attempted and is not claimed as verified. Safe interactive login, session cookies, transformed-secret redaction and authenticated screenshots need a dedicated security design.

Challenge detection is conservative and reports confidence. HTTP 401 is confirmed authentication-required; HTTP 403 alone is access-denied, not proof of CAPTCHA. Recognizable interstitial titles/markers or a login path with password input produce a heuristic attention state. No solving or bypass is attempted. Failed captures keep baseline/latest images. Challenge/auth checks back off at least 15 minutes. Optional alerts occur once per continuous state; recovery or a different state can produce a new alert.

Artifacts are limited to 16 MiB each; notification images are omitted above 4 MiB each or 8 MiB total. Outbox retries stop after five attempts. Remote deliveries remain at least once. Resource limits and finite timeouts bound execution but do not guarantee immunity to hostile content or disk exhaustion; aggregate disk budgets are future work.
