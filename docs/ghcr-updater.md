# Opt-in GHCR updater

The updater is disabled by default. It requires a dedicated unprivileged host
account, an operator-provided authenticated release-evidence fetcher, immutable
GHCR digest access, and an explicitly configured Compose project. It rejects
missing/ambiguous provenance, non-attested publishers, replay/downgrade, unsafe
drain and failed health checks. It never prunes Docker, removes volumes, clears
leases, or touches other Compose projects. Run dry-run first; enable the timer
only after operator review. Database rollback is manual unless migration
compatibility is independently proven.

Use a systemd `RuntimeMaxSec`, a locked-down environment file (0600), and a
host adapter that supplies authenticated GitHub/GHCR evidence, project-scoped
Compose operations, atomic state writes, safe worker drain and health probes.
The Docker socket is privileged: isolate this account and never share its
project name with unrelated stacks. A no-update run is silent; critical drain,
migration or health failures may use the optional Telegram notifier.
