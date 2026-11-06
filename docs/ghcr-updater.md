# Opt-in GHCR updater

The updater is disabled by default. The host needs only Docker Engine and
systemd: Docker Compose v2, Node.js 24, GitHub CLI 2.103.3 and the updater
runtime are packaged in an immutable GHCR image. It requires immutable GHCR digest
access and an explicitly configured Compose project. It rejects
missing/ambiguous provenance, non-attested publishers, replay/downgrade, unsafe
drain and failed health checks. It never prunes Docker, removes volumes, clears
leases, or touches other Compose projects. Run dry-run first; enable the timer
only after operator review. Database rollback is manual unless migration
compatibility is independently proven.

Use the checked-in container launcher and bounded systemd service, a locked-down
environment file (0600), and the host adapter that supplies authenticated GitHub/GHCR evidence,
project-scoped Compose operations, atomic state writes, safe worker drain and
health probes.
The Docker socket is root-equivalent: restrict host access and never share the
project name with unrelated stacks. A no-update run is silent; critical drain,
migration or health failures may use the optional Telegram notifier.

The concrete host adapter is `scripts/docker-compose-adapter.mjs`. Configure an
absolute project directory, a validated Compose project name, a local Unix
Docker socket, the configured production Compose file (including a legacy name
such as `compose.yml`) followed by the image-bundled
`docker-compose.ghcr.yml`, and an explicit
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
limits. Instead of trusting a hardcoded host path, API and Worker must
refer to the same project-contained, regular, non-symlink seccomp profile.
Its complete bytes must match the SHA-256 of the trusted
`docker/chromium-seccomp.json` bundled into the provenance-verified immutable
updater image. Absolute host paths and repository-relative paths are both
supported; `unconfined`, missing profiles, symlink escapes and changed
policies fail closed. The profile bytes are included in the stable
configuration fingerprint so a change during deployment validation is rejected.
It then inspects only containers carrying the configured Compose project
label and requires unambiguous service, working-directory and Compose-file
ownership. A first update may find labels containing only the configured base
file; later updater-owned application containers may contain the base plus the
immutable override. No other file set is accepted, and the configured project
name (including `changd-fusion-v030`) is never rewritten. The database container
ID and named volumes are retained across the
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
A periodic no-update check produces no notification or normal output.

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

The one-time bootstrap is a manually authorized maintenance procedure. All of
these prerequisites are mandatory:

1. Pin reviewed v0.3.3 API/UI digests and the exact source SHA; back up the
   PostgreSQL and capture volumes consistently. Pause the updater, deployment
   controller and any other supervisor that can recreate API/Worker replicas.
2. Inventory every API/Worker replica using this database. Reject a second host,
   unknown project, privileged/shared PID container or incomplete inventory.
3. Gracefully stop the v0.3.2 API and Worker with their existing 180-second
   Compose grace period. Confirm every inventoried replica is fully exited and
   cannot auto-restart. Full container termination is required because v0.3.2
   does not participate in migration 017's barrier.
4. Inspect only scheduler ownership fields and PostgreSQL advisory locks. If an
   active token, lock, running/restarting replica or ambiguous browser cleanup
   remains, stop and use the separately authorized offline recovery procedure;
   never clear a token or lock as part of bootstrap.
5. Keep PostgreSQL and capture volumes mounted unchanged. With old admission
   paths fenced, run the reviewed v0.3.3 `migrate` one-shot. Verify migrations
   017 then 018 and all prior checksums in `fusion_migrations`.
6. Run the v0.3.3 API image as a no-dependency one-shot and pipe structured JSON
   to `node dist/maintenance-cli.js bootstrap-confirm`. The JSON must contain the
   configured project, exact v0.3.3 source SHA and confirmation
   `I_HAVE_FENCED_V032_API_AND_WORKER`; none belongs in command arguments.
7. Verify `bootstrap-status`, then start only matching v0.3.3 API/Worker/UI
   digests. Confirm database/API/Worker/UI health and data counts before restoring
   supervisors. Leave the updater timer disabled until a separately approved
   dry-run succeeds.

For a generic Compose installation, the reviewed maintenance record should bind
the concrete values used by this command template. Run it only after steps 1–4
are independently satisfied and a separate maintenance authorization exists:

```sh
docker compose --project-name "$FUSION_COMPOSE_PROJECT" \
  --file docker-compose.yml --file docker-compose.ghcr.yml \
  --env-file "$FUSION_COMPOSE_ENV_FILE" stop --timeout 180 api worker

docker compose --project-name "$FUSION_COMPOSE_PROJECT" \
  --file docker-compose.yml --file docker-compose.ghcr.yml \
  --env-file "$FUSION_COMPOSE_ENV_FILE" run --rm --no-deps migrate

jq -n --arg project "$FUSION_COMPOSE_PROJECT" --arg source_sha "$SOURCE_SHA" \
  --arg confirmation I_HAVE_FENCED_V032_API_AND_WORKER \
  '{project:$project,source_sha:$source_sha,confirmation:$confirmation}' |
docker compose --project-name "$FUSION_COMPOSE_PROJECT" \
  --file docker-compose.yml --file docker-compose.ghcr.yml \
  --env-file "$FUSION_COMPOSE_ENV_FILE" run --rm --no-deps -T api \
  node dist/maintenance-cli.js bootstrap-confirm
```

`FUSION_API_IMAGE` and `FUSION_UI_IMAGE` in the protected Compose environment
must already contain the reviewed immutable digest references. A non-successful
confirmation is a hard stop; do not start application services or manufacture
the marker manually.

Migration 017/018 and bootstrap tests prove fail-closed database behavior, but
they cannot prove a production supervisor inventory or container termination.
Those remain operator evidence for first-upgrade acceptance. Never force-kill
Chromium, delete advisory locks, clear fencing tokens or recreate volumes. If any
check is uncertain, keep services stopped and perform manual recovery.

Every later candidate manifest includes the sorted SHA-256 ledger of checked-in
migrations. The automatic path currently permits only an exact match with the
installed ledger. A new, removed or changed migration is `unsafe_migration` and
requires a separately reviewed compatibility/bootstrap procedure. There is no
speculative database rollback; a post-mutation failure retains previous image
references and enters `RECOVERY_REQUIRED` without altering persistent volumes.

v0.4.0 adds migration 019 for the expiring interactive-editor presence barrier.
It is additive, but the updater deliberately does not self-approve that fact:
an existing v0.3.3 installation therefore stops with `unsafe_migration` until
an operator reviews and applies 019 through the same fenced, volume-preserving
migration procedure. After the installed ledger matches the signed candidate,
normal host-initiated automatic updates resume. When an existing installation
uses Compose project `changd-fusion-v030`, that exact project value must be
configured; the updater never renames it or recreates its database/capture
volumes.

## Notifications, installation and activation

Telegram is optional and uses only the official HTTPS Bot API with bounded
requests and redirects disabled. Configure both bot token and numeric chat ID in
the mode-0600 environment file. Success is recorded once per operation; critical
safe-stops and recovery-required states include only sanitized stage/category
data. Delivery failure is recorded separately and cannot change deployment
success, reopen admission or initiate rollback. No-update runs are silent.

Supported hosts require Linux with systemd, Docker Engine, a local Unix Docker
socket, PostgreSQL 16 application deployment, CA trust and
HTTPS access to GitHub/GHCR/Sigstore (and Telegram only when enabled). The image
contains Node.js 24, checksum-pinned official GitHub CLI and pinned Docker/Compose
clients. Keep the actual Compose project in the configured project directory,
create `/var/lib/changd-fusion-updater` mode 0700 owned by container UID/GID
10001, and install the environment file as mode 0600. The
optional read-only GitHub credential needs Actions/contents/package read access;
private GHCR pulls additionally require an operator-created, mode-0600 Docker
credential configuration under `/etc/changd-fusion/docker`. GitHub never receives
host SSH credentials.

The systemd launcher runs as host root only to start Docker, then runs the
updater process as UID/GID 10001 with a read-only root filesystem, all Linux
capabilities dropped and `no-new-privileges`. This is not a sandbox boundary:
the mounted Docker socket can control the host daemon and therefore remains
root-equivalent. The launcher mounts only the socket, configured project
read-only, updater state read-write and Docker credentials read-only. Host and
container project paths are intentionally identical so Compose ownership labels
remain stable and auditable.

If the configured Compose or environment file is root-only, the root launcher
creates a random mode-0700 staging directory in `/run`, containing **only**
the configured base Compose and environment files. Snapshots are mode-0400,
owned by UID/GID 10001. The original project root remains bound read-only
at its original absolute host path, and the snapshots overlay those same
absolute paths read-only. For a nested 0700 private environment directory,
a minimal staged directory view is mounted read-only to permit UID 10001 to
traverse it; unrelated files in that directory remain invisible. An
installation relying on additional private files must be reviewed separately.
The base Compose file must be in the project root; nested base files fail
closed. Production permissions, file ownership, volumes and Compose ownership
labels are never changed.

For legacy deployments where the seccomp policy also lives in a root-only
`private/chromium-seccomp.json` under the project root, the host launcher
stages this selected file alongside the protected environment (mode 0400,
UID/GID 10001), making it visible at the **same original absolute path** via
the existing read-only `private/` directory overlay. For another host layout,
the operator may explicitly set `FUSION_SECCOMP_PROFILE_FILE` to a canonical
project-contained absolute path; the launcher rejects symlink/hardlink and
out-of-project inputs, staging only that selected file and mounting a minimal
read-only directory/file view. The updater still independently checks the
verified profile contents. Do not alter production Compose paths, seccomp
permissions, or sandbox policy to satisfy a failed gate. If the legacy profile
does not match the trusted reference byte-for-byte, an operator must review
the actual policy difference; this PR deliberately does not approve it.

The configured host Docker CLI directory may itself be root-only (normally
`/etc/changd-fusion/docker` mode 0700). The launcher MUST NOT bind that
directory directly into the UID-10001 container. Instead, it creates a separate
UID-10001-owned, mode-0700 Docker configuration directory inside its existing
private `/run` staging area and binds this minimal view read-only at
`/home/updater/.docker`. Only a root-owned, regular, non-symlink,
single-hardlink `config.json` up to 128 KiB is copied, if present, as mode
0400. An absent file yields an empty configuration directory for public GHCR;
other host Docker files and credential helper binaries are never copied.

At runtime the updater accepts only direct `ghcr.io` registry authentication
in `config.json`. Credential helpers (`credsStore`, `credHelpers`), Docker
contexts, foreign registries and unexpected keys fail closed with static codes.
Operators using a credential helper must explicitly provision a separate
GHCR-only direct-auth configuration before activation; the updater never
modifies credentials or host Docker configuration. The pinned image is still
verified and the host Docker client can use its existing protected configuration
for the initial immutable updater image pull. Snapshot files are securely
removed on exit, errors and termination, without writing sensitive contents
to logs or changing original permissions.

The launcher keeps its parent process alive for cleanup on exit or signals,
uses a scoped Docker `--cidfile` for interruption handling, and never prints
snapshot contents. Filesystem errors are emitted only as sanitized categories,
not secret-bearing paths or stack traces. The host-installed launcher
`/usr/local/sbin/changd-fusion-updater-container` is NOT bundled into
the updater image: a future operator-approved host launcher update is required
independently of pulling the new GHCR image.

### Clean-host installation (disabled by default)

1. Install Docker Engine and systemd. Do not install Node.js, npm, GitHub CLI,
   Docker Compose or build tools on the host.
2. Obtain the immutable updater reference from the successful `GHCR updater
   release` run and verify its digest and attestation on an administration
   workstation:

   ```sh
   gh attestation verify \
     oci://ghcr.io/mkaand/changd-fusion-updater@sha256:REVIEWED_DIGEST \
     --repo mkaand/changd-fusion \
     --source-ref refs/heads/master \
     --signer-workflow .github/workflows/ghcr-updater-release.yml
   ```

3. Run the checked-in installer with the existing Compose identity and paths:

   ```sh
   sudo scripts/install-ghcr-updater.sh \
     --image ghcr.io/mkaand/changd-fusion-updater@sha256:REVIEWED_DIGEST \
     --project changd-fusion-v030 \
     --project-dir /opt/changd-fusion-v030 \
     --compose-file /opt/changd-fusion-v030/compose.yml \
     --compose-env /opt/changd-fusion-v030/.env
   ```

4. Configure optional read-only GitHub/Telegram credentials in the mode-0600
   environment file. Keep `FUSION_UPDATER_DRY_RUN=1`, run
   `systemctl start changd-fusion-updater.service`, and inspect its zero-mutation
   plan.
5. Activation requires separate approval: change dry-run to `0`, repeat the
   reviewed oneshot, then run
   `systemctl enable --now changd-fusion-updater.timer`. The timer checks about
   every five minutes with a bounded randomized delay. No-update runs are silent.

The installer performs `daemon-reload` but never starts or enables the service
or timer. On
`FAILED`, correct the pre-mutation issue and retry. On `RECOVERY_REQUIRED`, stop
the timer, preserve state/database/captures, inspect journal and immutable image
identities, and follow a separately approved manual recovery; do not edit the
state file or clear the maintenance record to force progress.

## Remaining release acceptance

Fixture tests exercise the complete updater control flow, but the first approved
release must still verify live GitHub Actions discovery, both GHCR OCI digests,
both GitHub Artifact Attestations, package pull authorization, the generic-host
dry-run and optional Telegram delivery. No fixture result is presented as live
registry or production evidence.

Disable JavaScript continues to use `javaScriptEnabled: !disable_javascript` in
scheduled capture and all Region Preview modes. Its deterministic real-Chromium
fixture is included in the required `npm run test:integration` suite; the
dedicated `npm run test:integration:disable-javascript` command remains useful
for focused diagnosis. Live external-site behavior remains separate acceptance
evidence and is never inferred from local fixtures.
