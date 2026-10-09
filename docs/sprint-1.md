# Sprint 1 review notes

The implemented vertical slice is the modern application, secure monitor/channel API, versioned PostgreSQL migration, sandboxed hybrid capture, precise Pixelmatch comparison, one combined event/outbox, native SMTP/Telegram providers and the Changd-style Ant Design interface.

Architecture deliberately uses PostgreSQL for coordination/outbox and a sequential worker for small hosts; no Redis or separate monitoring product is introduced. The visual comparator is an interface so Looks-Same can be added later. Migration imports legacy monitors/history while preserving old percentage values and artifact references. It does not run a production migration.

Completed regression coverage includes ownership, authentication/admin checks, mutation headers/origin, disabled registration, removed scheduler endpoint, private network/metadata restrictions, DNS mixes, redirect/proxy enforcement, filesystem containment, credential encryption, zero/tiny/equal/100% image differences, dimensions/corruption, one-session browser capture, normalization/masks/selectors, combined event uniqueness, retry/restart behavior, automatic scheduling, migration repeatability, legacy data preservation, SMTP/Telegram mocks, repaired login tests and desktop/mobile browser smoke checks. The browser history check shows a persisted 0.35% event; notification mocks verify the same decimal is delivered.

Remaining work for the next sprint:

- Review and integrate the owner's actual shared-ui Light/Dark/System source. Only the theme boundary is prepared.
- Review a legacy screenshot/S3/channel import path, pagination and operational retry tooling for failed notifications.
- Add account/session revocation, secure recovery, accessibility/keyboard coverage and richer monitor failure/status UX.
- Validate Chromium sandbox policy and persistent volumes on the intended deployment platform in a separately authorized task; no production changes occur here.
- Run provider delivery tests in a securely configured test environment if real email/Telegram verification is later authorized.
- Add limits/metrics for larger workloads, optional full-page capture, additional JSON ignore/extraction rules and a future alternative visual comparator.

No exactly-once remote-delivery, complete security-audit, established-theme match, production-readiness or deployment claim is made.
