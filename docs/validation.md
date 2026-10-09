# Sprint 1 validation

All checks below were executed in the isolated development Cloud workspace with synthetic accounts, local fixtures and disposable databases. No production system or real notification credential was used.

| Check | Result |
| --- | --- |
| Node 24 clean `npm ci` in both packages | Passed |
| TypeScript backend build | Passed |
| Frontend TypeScript + Vite production build | Passed; large-bundle warning remains |
| Backend unit/provider/security tests | 11 passed, 0 failed/skipped |
| PostgreSQL integration/browser tests | 14 passed, 0 failed/skipped |
| Frontend form/precision tests | 3 passed, 0 failed/skipped |
| Full dependency audit (both packages, including development dependencies) | 0 reported vulnerabilities at validation time |
| API and UI Docker builds | Passed |
| Docker fresh schema migration and synthetic admin creation | Passed |
| Docker API authentication, UI proxy and restart smoke | Passed |
| Non-root sandboxed Chromium in Docker with included Playwright seccomp profile | Passed |
| Source/build privacy scan and inherited-history credential-pattern scan | Passed within scanner scope; manual review also performed |
| GitHub Actions | Workflow added; remote execution not yet verified |
| Real SMTP / Telegram delivery | Not attempted; providers tested with mocks |

The known legacy login test was repaired: it now submits a real form, checks the API payload, verifies the successful-authentication callback, and checks an unsuccessful login never reports success. No failing test is disabled.

Intermediate failures were diagnosed and corrected: legacy Node/Sharp dependencies were replaced; the HTTP fetch lookup callback was corrected for Node 24 multi-address resolution; browser-fixture paths and forced test-database teardown were corrected; non-root migration/config file permissions were corrected; and Docker namespace denial was resolved using the official Playwright seccomp profile. Cloud restricted the bundled Playwright CDN download, so the Docker image uses a pinned, signed Debian Chromium package instead. TLS and package verification remained enabled.

The precision path verifies `0.35%` in the pixel comparison, PostgreSQL NUMERIC storage, authenticated API response, rendered browser history and mocked notification delivery. Zero, tiny changes, exact threshold equality, 100%, dimensions, corrupt image comparison and failed captures are covered. Hybrid text+visual changes produce one event and one unique outbox row per channel. Delivery retries and restart recovery are tested, with the documented at-least-once remote-delivery limitation.

Inherited public history contains upstream author/contact strings; that existing history was scanned without printing values and was not rewritten. The new source/build tree and new commit identity contain no personal email addresses; examples use synthetic addresses and the required Codex attribution.

The original MIT license is unchanged. Runtime configuration, test screenshots, credential files, build outputs and logs remain outside the committed tree. Public examples use example.com and synthetic fixtures. These checks do not constitute a complete security audit or prove production readiness.
