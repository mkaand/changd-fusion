# Changd Fusion

Self-hosted website change detection with **one Docker container**, **SQLite WAL**, a single persistent volume and sandboxed Chromium. Text, visual and hybrid monitors, Selected Element/Area, Browser Steps, mobile Preview, Check Now and Telegram/SMTP notifications share the same application runtime.

Based on [Changd by Paul Aschmann](https://github.com/paschmann/changd). MIT attribution and third-party notices are retained.

![Dashboard](docs/images/dashboard-desktop.png)

## Requirements

Docker Engine, Docker Compose v2, and sufficient memory for Chromium (2 GiB available RAM is a reasonable starting point, not a measured minimum). The application is designed for **one instance**, not HA or multi-replica deployment. The tested CI platform is Linux x86-64.

## Installation

```sh
git clone https://github.com/mkaand/changd-fusion.git
cd changd-fusion
cp .env.example .env
docker compose up -d --build
docker compose exec fusion cat /data/setup-token
```

Open `http://localhost:8127/setup`, enter the one-time setup token and create the first administrator. Production hosting needs an HTTPS reverse proxy. Set `FUSION_SIMPLE_PUBLIC_URL=https://your-domain.example` in `.env` and recreate the service with `docker compose up -d --no-deps fusion`. Port 8127 binds to **127.0.0.1 only**. Do not expose it publicly without HTTPS.

## Architecture

- One `fusion` service: React UI, Node.js API, scheduler, Telegram/SMTP outbox and isolated Chromium capture subprocesses
- One named `simple-data` volume mounted at `/data`: SQLite database, WAL files, captures, encrypted channel information, credentials and setup state
- One internal Chromium execution queue prioritizes user Preview and Check Now over scheduled work. No PostgreSQL, background Worker, separate API/UI service, updater, external browser lease or host Node installation
- `server/src` contains only the **shared browser/capture/validation library** compiled into the same application image, not a separate runtime service

`compose.simple.yml` remains as an equivalent compatibility entrypoint for existing Simple installations. New installations should use the root `docker-compose.yml` via the default `docker compose` commands.

## Operations

```sh
docker compose ps
docker compose logs --tail=100 fusion
docker compose restart fusion
docker compose stop fusion
docker compose start fusion
```

`docker compose down` keeps the named volume; **`docker compose down -v` destroys it**. No automatic updater is enabled. To upgrade, record the previous source commit, back up `/data`, pull a reviewed revision and run `docker compose up -d --build`. Never overwrite a running SQLite database with a backup.

## Offline backup and restore

Stop the service before a full-volume snapshot, including SQLite WAL and artifacts:

```sh
umask 077
docker compose stop fusion
docker run --rm -v changd-fusion-simple_simple-data:/data:ro -v "$PWD":/backup alpine:3.21 sh -c 'cd /data && tar -czf /backup/fusion-simple-backup.tar.gz .'
docker compose start fusion
```

Restore only to a stopped instance with a verified separate rollback copy. Restore the archive into the correct named data volume with original ownership/permissions, then confirm login, monitor counts and health. Never restore to a populated live volume or use `down -v` during normal maintenance. Backups contain secrets; protect them.

## Migrating configuration from an older PostgreSQL installation

Optional, one-time tools `simple/export-pg.mjs` and `simple/import-settings.mjs` import account settings, monitor configuration, encrypted channel/vault data and relationships into an **empty** SQLite database. PostgreSQL is needed only on the export side; it is never an application runtime dependency. Use a read-only source connection and the original `CHANNEL_KEY`; do not print secrets. Captures/history are not migrated and fresh baselines are established without false change alerts. Review the CLI environment requirements before using this irreversible migration path.

## CI and security

`.github/workflows/simple-ci.yml` builds the actual single-service Docker image and tests SQLite integrity, migration, real sandboxed Chromium capture and Preview, queue cleanup, user setup, notification handling and restart persistence. Chromium has a sandbox, scoped egress policy and bounded resources. The app uses session cookies, same-origin protections and owner-scoped storage. Public Access, where enabled, intentionally exposes workspace capabilities; use it only if desired.

**Production deployment is explicit and manual.** GitHub commits do not trigger a VPS updater or automatically modify a running installation. The historic multi-container architecture has been removed from this checkout.
