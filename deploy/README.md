# Optional immutable GHCR deployment

This is an opt-in host-side updater for the single-container SQLite architecture. It does not add an updater container, Worker, PostgreSQL or a production build. GitHub has no host credentials: a root-owned systemd timer on the server initiates read-only GitHub/GHCR checks and narrowly scoped Docker Compose operations.

## Requirements and trust boundary

- Linux x86-64, Bash, Docker Engine, Docker Compose v2, `curl`, `jq`, `flock` and coreutils
- A reviewed clone containing the matching `docker-compose.ghcr.yml` and `deploy/simple-updater.sh`
- Public anonymous pull access to `ghcr.io/mkaand/changd-fusion`; the updater intentionally has no credential fallback
- Public read access to the repository master commit API
- At least 2 GiB free by default (configurable upward)
- Root-owned configuration/state (`0700` directory, `0600` files)

Access to `/var/run/docker.sock` is effectively root access. The service therefore runs reviewed local code as root, validates the Compose project and service labels, and mutates only `fusion`. It never uses `down`, removes volumes, builds images, prunes Docker globally or operates on another Compose project.

The updater accepts only the standardized Docker identity: project `changd-fusion`, container `changd-fusion`, service `fusion`, named volume `changd-fusion-data`, network `changd-fusion_default`, and GHCR repository `ghcr.io/mkaand/changd-fusion`. Both the running container and the candidate-digest-resolved Compose configuration must match it exactly.

The published image has immutable digest, source/revision/version and SQLite schema labels. Publication occurs only for a `master` push after the existing SQLite/code and real-container CI jobs succeed. The updater independently requires the image revision to equal GitHub's current `master` SHA. A new SQLite schema is never applied automatically.

## One-time installation (manual approval required)

These steps are examples; choose generic host paths appropriate for your installation. Do not enable the timer until the contract and bootstrap output have been reviewed.

1. Confirm the installation already uses the standardized project, container, network and `changd-fusion-data` volume. Older `changd-fusion-simple_simple-data` volumes are never renamed or adopted automatically; stop the old service and complete the controlled offline migration in the root README before configuring the updater. Copy `deploy/changd-fusion-updater.env.example` to `/etc/changd-fusion/updater.env`, make it root-owned mode `0600`, and set the exact existing paths and health URL. The final Compose file must be this repository's `docker-compose.ghcr.yml`.
2. Back up `/data` using the offline procedure in the root README.
3. Pin a reviewed, healthy initial image manually and start only the `fusion` service without building:

   ```sh
   export FUSION_IMAGE_REF='ghcr.io/mkaand/changd-fusion@sha256:<reviewed-digest>'
   docker compose --project-name 'changd-fusion' \
     -f '<existing-base-compose>' -f '<repo>/docker-compose.ghcr.yml' \
     up -d --no-build --no-deps fusion
   ```

4. With the environment file loaded, record and review the immutable runtime contract. It includes the project/service identity, loopback port, named `/data` volume, networks, declared environment values, seccomp, memory, PID/SHM and restart settings. Protect it because environment values may be sensitive.

   ```sh
   set -a; . /etc/changd-fusion/updater.env; set +a
   /opt/changd-fusion/deploy/simple-updater.sh snapshot-contract
   jq . "$FUSION_CONTRACT_FILE"
   /opt/changd-fusion/deploy/simple-updater.sh bootstrap-state
   /opt/changd-fusion/deploy/simple-updater.sh verify
   ```

   Bootstrap refuses a locally built or mutable-tag-only running image. This guarantees a known immutable rollback target before automation begins.

5. Copy the reviewed service and timer to `/etc/systemd/system/`, adjust only generic installation paths if needed, run `systemctl daemon-reload`, and execute one manual `systemctl start changd-fusion-updater.service`. Review `journalctl -u changd-fusion-updater.service` and application health. Enabling `changd-fusion-updater.timer` is a separate manual approval. The timer checks every five minutes with a small randomized delay and is disabled in the repository.

## Update and failure behavior

Each run uses `flock`, checks disk and anonymous registry access, resolves the `master` digest, verifies immutable image metadata and current GitHub master SHA, and compares it with atomic local state. The same digest is a silent no-op. Before and after replacement it checks SQLite integrity and schema compatibility. Record counts are deliberately not deployment gates because users, monitors, captures, events and channels may change naturally while an update runs. Compose is called only as:

```text
up -d --no-build --no-deps fusion
```

The existing named `/data` volume and all unrelated services remain untouched. Success requires Docker HEALTHY, the loopback `/api/v1/health` response, the expected digest, the unchanged runtime contract, SQLite integrity and the compatible schema. A failure quarantines that digest, removes its image only when no container uses it, and makes one rollback attempt to the last healthy digest. A failed rollback records `recovery_required`; every subsequent automatic update is blocked. Stop the timer, recover manually from the preserved image/state and offline backup, then run `simple-updater.sh recover-state`. That explicit command revalidates the runtime contract, immutable running image, health, SQLite integrity and schema before atomically clearing the lock. Schema-label mismatch always requires a separately reviewed manual migration.

After success, cleanup considers only old `ghcr.io/mkaand/changd-fusion` digest references, retains current and rollback digests, and skips every image ID used by any container. No prune command is used.

## Notifications

Set both `FUSION_TELEGRAM_BOT_TOKEN` and `FUSION_TELEGRAM_CHAT_ID` in the protected host environment file to receive successful version changes and critical update/rollback failures. Tokens are neither committed nor logged. The application's encrypted notification configuration is deliberately not extracted from SQLite. With no updater-specific credentials, deployment still works and emits only local journal messages; no-update checks remain silent.

## Recovery and configuration changes

Stop the timer before any intentional Compose change. After reviewing the new port, network, environment, volume and security contract, run `snapshot-contract` manually again. Never regenerate the contract merely to bypass an unexpected mismatch. Never remove or replace the `/data` volume, restore over a live SQLite database, or use broad Docker prune commands.
