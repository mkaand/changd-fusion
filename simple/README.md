# Changd Fusion Simple: single-container SQLite architecture

STATUS: DEVELOPMENT PREVIEW. NOT YET PARITY-TESTED OR APPROVED FOR PRODUCTION MIGRATION.

This is an independently runnable implementation, not an alternative compose
file pointing to the old PostgreSQL stack.

Architecture:
- One Node.js runtime serves the existing React UI and authenticated API.
- The same runtime schedules checks, stores state in SQLite WAL, and sends notifications.
- Chromium captures run in disposable subprocess groups in the same container.
- Local browser queue preempts scheduled work for interactive preview.
- One persistent data volume contains the database and screenshot artifacts.
- No PostgreSQL, separate Worker/API/UI/migration/updater containers or durable browser lease.
- A timed-out monitor must never destroy configuration or its previous baseline.

Local preview, without touching existing production:

1. Clone the repository on any Docker + Compose host.
2. Run: docker compose -f compose.simple.yml up -d --build
3. Obtain the initial one-use setup token:
   docker compose -f compose.simple.yml exec fusion cat /data/setup-token
4. Open http://localhost:8127/setup, enter token, administrator email and password.
5. The existing React UI is served from the same port.

Only localhost is exposed by default. Configure a TLS reverse proxy and
FUSION_SIMPLE_PUBLIC_URL for remote use. Runtime Node.js and Chromium are
bundled inside the image. Production deployment remains unchanged.

Settings migration design:
- Original PostgreSQL settings are exported read-only using simple/export-pg.mjs
  from a trusted isolated Node.js container with secure DATABASE_URL and
  FUSION_EXPORT_FILE. This export includes encrypted channel configs and vault
  fields, bcrypt hashes and ALL monitor settings, but no history or screenshots.
- Transfer the resulting 0600 bundle to the new instance privately.
- On an EMPTY target SQLite database, run simple/import-settings.mjs with
  FUSION_IMPORT_FILE and FUSION_DATA_DIR. Supply the original CHANNEL_KEY for
  encrypted channel/vault compatibility. Do not put keys on command lines.
- Imported monitor IDs, users, channels, links and settings are preserved.
  Imported baselines are intentionally reset; first successful capture establishes
  a new baseline, without a change notification.
- The exporter never changes production DB rows; importer rejects partial or
  duplicate configuration and rolls back all writes on a failure.

CURRENT PARITY LIMITATIONS: full account security controls, notification
digests/delivery-history UI and analytics filters require implementation and
acceptance tests. Do not migrate the production instance until all existing
configuration/features in active use have passed parity tests.

Safety: no public registration, no inbound host Docker socket, one runtime
instance, sandboxed Chromium, restrictive egress policy, credential encryption
and owner-scoped data access. Multi-replica / HA mode is deliberately unsupported.
