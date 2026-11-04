# Opt-in GHCR updater

The updater is disabled by default. It requires a dedicated unprivileged host
account, an operator-provided authenticated release-evidence fetcher, immutable
GHCR digest access, and an explicitly configured Compose project. It rejects
missing/ambiguous provenance, non-attested publishers, replay/downgrade, unsafe
drain and failed health checks. It never prunes Docker, removes volumes, clears
leases, or touches other Compose projects. Run dry-run first; enable the timer
only after operator review. Database rollback is manual unless migration
compatibility is independently proven.
