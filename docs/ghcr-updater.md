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

Release discovery needs read-only Actions access to the trusted repository. It
lists `ghcr-release.yml` runs and run artifacts through `api.github.com`, then
downloads the exact `ghcr-release-manifest-<source-sha>` ZIP from GitHub's signed
artifact storage. The bearer token is never forwarded to that storage redirect.
Production must allow HTTPS only to the GitHub API and the documented GitHub
artifact hosts. ZIP structure and manifest fields are bounded and validated,
but artifact transport is not publisher authentication: source ancestry and
image attestation gates remain mandatory and fail closed independently.
