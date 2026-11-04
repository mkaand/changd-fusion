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

The concrete host adapter is `scripts/docker-compose-adapter.mjs`. Configure an
absolute project directory, a validated Compose project name, a local Unix
Docker socket, the checked-in
`docker-compose.yml` followed by `docker-compose.ghcr.yml`, and an optional
operator-owned environment file. The adapter always selects the local Docker
socket, removes inherited endpoint/TLS selectors from child commands, invokes
Docker with structured arguments and bounded output/timeouts, and never uses a
shell. The GHCR override uses Compose `!reset null` so `migrate`, API, Worker and
UI cannot inherit local build definitions. Ordinary clone-based Compose usage is
unchanged when the override is not supplied.

Before mutation, the adapter validates the effective JSON model, exact service
set, immutable API/UI images, shared API/Worker/migration image, project-scoped
network and persistent volume names, UI loopback binding, seccomp settings,
`CHROMIUM_CONCURRENCY=1`, and the checked-in API/Worker CPU, memory, PID and SHM
limits. It then inspects only containers carrying the configured Compose project
label and requires unambiguous service, working-directory and Compose-file
ownership. The database container ID and named volumes are retained across the
health gate. Pull and update are limited to `api`, `worker` and `ui`; update uses
`--no-deps --no-build`, so the database is never recreated and no local build is
possible. No prune, down, force-remove or volume-removal operation is exposed.

Mutation additionally requires a fresh, project/source-bound, single-use drain
authorization accepted by an injected application-level verifier. No verifier,
expired or replayed evidence, or a mismatched source fails closed. Migration 017
adds a durable PostgreSQL maintenance barrier. `server/src/maintenance-cli.ts`
and `scripts/maintenance-coordinator.mjs` establish it through a structured,
stdin-only `docker compose exec` call; the secret owner token is never placed in
process arguments. The coordinator is automatically attached as the adapter's
drain verifier before project validation.

Barrier creation serializes on the same scheduler row used by Chromium
admission. New scheduled Chromium work, Preview (including retained-session
reuse), and Manual Check requests are rejected while active work finishes
cooperatively. Drain confirmation requires both an empty durable scheduler token
and absence of the PostgreSQL Chromium advisory lock. The project, exact release
SHA, deployment operation, token hash and evidence deadline remain bound in the
database. Ownership is reverified before pull, replacement and health approval;
the barrier opens only after health and state recording succeed. Timeout,
ownership loss, updater interruption or deployment failure leaves
`recovery_required` admission closed for separately verified manual recovery—an
expired lease or process absence never opens it. Dry-run performs read-only
configuration/ownership validation and creates no maintenance record or Docker
mutation.

Release discovery needs read-only Actions access to the trusted repository. It
lists `ghcr-release.yml` runs and run artifacts through `api.github.com`, then
downloads the exact `ghcr-release-manifest-<source-sha>` ZIP from GitHub's signed
artifact storage. The bearer token is never forwarded to that storage redirect.
Production must allow HTTPS only to the GitHub API and the documented GitHub
artifact hosts. ZIP structure and manifest fields are bounded and validated,
but artifact transport is not publisher authentication: source ancestry and
image attestation gates remain mandatory and fail closed independently.

Before planning any deployment, the release client resolves `master` through
the trusted GitHub repository and requires the release commit to be the exact
merge base of `source...master`. It then verifies the raw digest-pinned GHCR
OCI index/manifest and configuration bytes, selects exactly one `linux/amd64`
platform, and checks source, revision, and version labels. API and Worker must
share one verified digest. A mutable tag is never accepted.

Publisher authentication uses GitHub Artifact Attestations generated by the
official pinned `actions/attest-build-provenance` action. The production host
requires GitHub CLI 2.103.3 or newer, read access to the public
repository/packages and the GitHub public-good Sigstore trust root. Verification
uses `gh attestation verify` with the full repository/workflow identity, exact
source digest and master ref, GitHub OIDC issuer, SLSA v1 predicate and
self-hosted-runner denial. It additionally parses the verified certificate,
transparency/timestamp evidence, subject digest and provenance statement rather
than trusting process exit alone. The updater token is passed only through
`GH_TOKEN`; it is never included in command arguments. A missing or old CLI,
offline transparency/signature evidence, mismatched claim, or unavailable OCI
blob aborts before a deployment plan is accepted.

The isolated CI `attestation` job installs the official, checksum-pinned GitHub
CLI distribution and verifies an immutable signed fixture from the GitHub CLI
repository. It covers a valid cryptographic signature plus tampered artifacts,
invalid signatures, incorrect repository/workflow/source identities, subject
digest mismatch and a missing verifier. The fixture and trusted-root hashes are
pinned; the job has read-only repository permission and publishes no image or
attestation. A real Changd Fusion release still requires a post-publication live
verification of both immutable GHCR digests before deployment is authorized.
