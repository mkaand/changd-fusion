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

## Runtime state and health gates

`scripts/ghcr-updater-runtime.mjs` is the concrete opt-in entry point. It wires
authenticated release discovery, the scoped Compose adapter, PostgreSQL
maintenance coordinator, durable deployment state and optional Telegram
transport. Required settings are documented in
`systemd/changd-fusion-updater.env.example`. The trusted repository is fixed to
`mkaand/changd-fusion`; paths and the Compose project remain host-configurable.
An hourly no-update check produces no notification or normal output.

The state directory must be owned by the updater account and mode 0700. State is
written mode 0600 using a same-directory exclusive temporary file, file fsync,
atomic rename and directory fsync. A separate exclusive operation lock rejects
concurrent runs. Lifecycle states are `IDLE`, `PREPARING`, `DRAINING`,
`DEPLOYING`, `VERIFYING`, `SUCCESS`, `FAILED` and `RECOVERY_REQUIRED`. Candidate,
current and previous immutable releases and the operation UUID are retained.
Malformed state, a runtime/image mismatch, an interrupted active state or lost
maintenance ownership fails closed. `RECOVERY_REQUIRED` is never cleared by the
timer; an operator must establish actual container, database, Chromium and
maintenance safety before any separately reviewed recovery action.

Before replacement, the updater records a read-only database baseline: monitor,
enabled, paused, baseline, History and capture counts, a stable monitor-state
signature, and the applied migration checksums. Verification runs while the
maintenance barrier remains closed. It requires the same PostgreSQL container,
volumes and data baseline, healthy API/Worker/database containers, the expected
UI response, exact version/source/digests, unchanged resource/security settings,
and a still-owned `deploying` maintenance record. Health therefore does not mean
browser admission is open. Only after health passes and `SUCCESS` is durably
recorded may the coordinator remove the barrier. State separately records
whether that release completed; a crash between durable success and barrier
release is reconciled to `RECOVERY_REQUIRED`, never assumed complete.

## Initial v0.3.2 bootstrap and migration policy

Migration 017 is additive, but a v0.3.2 API and Worker do not know its admission
barrier. Applying the table alone cannot prevent those old processes from
starting new Preview, Manual Check or scheduled browser work. Consequently the
timer **must not** automate the first v0.3.2 to v0.3.3 transition. Migration 018
adds an explicit singleton bootstrap marker; an absent marker returns
`BOOTSTRAP_REQUIRED` before runtime replacement or image pulls.

The one-time bootstrap is a manually authorized maintenance procedure. The
operator must disable automatic restart of the old application services, allow
all active work to finish, positively verify scheduler tokens, runtime-operation
rows and the PostgreSQL Chromium advisory lock are idle, then gracefully stop
the old API and Worker. With those old admission paths fenced, run the reviewed
v0.3.3 migration service, invoke `maintenance-cli.js bootstrap-confirm` from the
v0.3.3 API image using structured stdin containing the exact confirmation
`I_HAVE_FENCED_V032_API_AND_WORKER` plus the configured project and exact v0.3.3
source SHA (the `bootstrap-confirm` action never accepts these values in command
arguments),
and start/verify the v0.3.3 services. Never force-kill Chromium, delete advisory
locks, clear fencing tokens or recreate volumes. This procedure is intentionally
not an updater command: host-specific service fencing and positive browser-idle
evidence require operator review. If any check is uncertain, leave services
stopped/barrier closed and recover manually.

Every later candidate manifest includes the sorted SHA-256 ledger of checked-in
migrations. The automatic path currently permits only an exact match with the
installed ledger. A new, removed or changed migration is `unsafe_migration` and
requires a separately reviewed compatibility/bootstrap procedure. There is no
speculative database rollback; a post-mutation failure retains previous image
references and enters `RECOVERY_REQUIRED` without altering persistent volumes.

## Notifications, installation and activation

Telegram is optional and uses only the official HTTPS Bot API with bounded
requests and redirects disabled. Configure both bot token and numeric chat ID in
the mode-0600 environment file. Success is recorded once per operation; critical
safe-stops and recovery-required states include only sanitized stage/category
data. Delivery failure is recorded separately and cannot change deployment
success, reopen admission or initiate rollback. No-update runs are silent.

Supported hosts require Linux with systemd, Node.js 24, Docker Engine and Docker
Compose v2, a local Unix Docker socket, PostgreSQL 16 application deployment,
GitHub CLI 2.103.3 or newer, CA trust and HTTPS access to GitHub/GHCR/Sigstore
(and Telegram only when enabled). Install the reviewed repository under
`/usr/local/lib/changd-fusion`, keep the actual Compose project in the configured
project directory, create `/var/lib/changd-fusion-updater` mode 0700 owned by the
dedicated account, and install the example environment file as mode 0600. The
optional read-only GitHub credential needs Actions/contents/package read access;
private GHCR pulls additionally require an operator-created, mode-0600 Docker
credential configuration under `/etc/changd-fusion/docker`. GitHub never receives
host SSH credentials. The Docker socket is root-equivalent; restrict account
membership and host access.

Leave `FUSION_UPDATER_DRY_RUN=1`, install but do not enable the service/timer,
then run the oneshot manually and inspect the read-only plan. Activation requires
separate approval: change dry-run to `0`, run `systemctl daemon-reload`, and enable
the timer. The repository never performs these host actions automatically. On
`FAILED`, correct the pre-mutation issue and retry. On `RECOVERY_REQUIRED`, stop
the timer, preserve state/database/captures, inspect journal and immutable image
identities, and follow a separately approved manual recovery; do not edit the
state file or clear the maintenance record to force progress.
