# Changd Fusion Simple

**Status: DEVELOPMENT PREVIEW.** This is the single-container SQLite implementation under review in PR #56. The legacy production installation is unaffected. Passing CI is **not** authorization to migrate production.

## Architecture

One Docker Compose service (`fusion`) runs the React UI, Node.js API, scheduler, notification dispatcher and isolated Chromium subprocesses. Persistent state and screenshots reside under `/data` in a single named Docker volume. SQLite uses WAL mode. A local Chromium queue prioritizes Preview and Check Now. No PostgreSQL, separate API/UI/Worker/migration/updater service, host Node.js or host Chromium is needed. Only one runtime instance is supported; multi-replica/HA is not a goal.

## Minimum setup

- A host with Docker Engine and Docker Compose v2, adequate free disk space and enough RAM for Chromium (2 GB available RAM is a reasonable starting point, not a measured minimum).
- Ports: the default host binding is **127.0.0.1:8127**. The container listens on port 3000. A reverse proxy with HTTPS is required for safe access from other machines.
- The published Simple CI currently exercises a Linux x86-64 container. Validate any other target architecture before relying on it.

From a fresh checkout of the Simple development branch:

```sh
git clone https://github.com/mkaand/changd-fusion.git
cd changd-fusion
git switch feature/simple-single-container-sqlite
docker compose -f compose.simple.yml up -d --build
docker compose -f compose.simple.yml exec fusion cat /data/setup-token
```

Open `http://localhost:8127/setup`, enter the one-use token and create the first administrator. The existing React UI is served from the same origin. No public registration is enabled.

Set `FUSION_SIMPLE_PUBLIC_URL` to your actual HTTPS origin when publishing through your reverse proxy. Do **not** expose port 8127 openly without HTTPS and access controls.

## Everyday operations

```sh
docker compose -f compose.simple.yml ps
docker compose -f compose.simple.yml logs --tail=100 fusion
docker compose -f compose.simple.yml stop fusion
docker compose -f compose.simple.yml start fusion
docker compose -f compose.simple.yml restart fusion
```

The Docker `unless-stopped` policy restarts the container after an unexpected process exit. Chromium failures should remain scoped to their capture and not alter the last valid baseline. A stuck Preview cleanup has a process watchdog so the whole one-service runtime can restart instead of retaining a browser slot forever.

**Data preservation:** `docker compose down` does not remove the named data volume; `docker compose down -v` **does remove it** and must not be used on an installation whose data matters.

## Offline backup and restore

Stop the service to obtain a consistent SQLite WAL and artifact snapshot. This example uses a temporary Alpine utility container **only for copying a stopped volume**, never as an application dependency. Keep backup archives private: they contain accounts and encrypted secrets.

```sh
umask 077
docker compose -f compose.simple.yml stop fusion
docker run --rm -v changd-fusion-simple_simple-data:/data:ro -v "$PWD":/backup alpine:3.21 sh -c 'cd /data && tar -czf /backup/fusion-simple-backup.tar.gz .'
docker compose -f compose.simple.yml start fusion
```

Before restoring, stop the service, retain a separate copy of its current volume, and restore the archive into the `simple-data` volume with its file permissions/ownership preserved. Do not restore over a running instance, or onto a populated instance without a verified rollback copy. Verify login, monitor counts, screenshots and scheduled checks after restoring.

For a manual application update, back up the volume first, update the checked-out source to a verified commit, and run `docker compose -f compose.simple.yml up -d --build`. The existing named volume remains mounted. Automated deployment is **not** enabled in Simple preview.

## Settings-only migration from PostgreSQL

Migration is a separately authorized operation and must not overwrite the old installation.

1. Back up and verify the old PostgreSQL configuration and retain the original installation untouched.
2. Use `simple/export-pg.mjs` in a trusted environment with read-only `DATABASE_URL` and an absolute `FUSION_EXPORT_FILE`. The exporter uses a repeatable-read, read-only transaction. Keep the resulting JSON `0600`.
3. Transfer the bundle privately to the new instance. On an **empty** target SQLite database, run `simple/import-settings.mjs` with absolute `FUSION_IMPORT_FILE` and `FUSION_DATA_DIR`. Provide the original `CHANNEL_KEY` through a secure environment file, not command-line arguments.
4. Compare imported users, all monitor IDs and advanced settings, channels, relationships, preferences and private-value bindings against the source. Test password login and notification delivery.
5. Old screenshots, history and baseline captures are not imported. Each imported monitor builds a new baseline at its first successful check without a false change alert. Keep the old database and backup until separately authorized to retire them.

CI includes a **synthetic 12-monitor import** using the actual importer, with decryption checks and a wrong-key rejection test. This does **not** replace a rehearsal with the real 12 production configurations.

## Acceptance boundaries

The Simple CI exercises setup/login, account session isolation, public workspace controls, persistent SQLite across restart, baseline/change/failure paths, notification suppression/digests/delivery records, real sandboxed Chromium captures, Selected Element/Area, JavaScript-disabled Preview and scroll, and a synthetic migration. Some tests are API or backend tests, not full browser UI end-to-end acceptance.

**Still required before production approval:** real production-specific settings export/import rehearsal, full end-to-end UI acceptance for selected-element/area and Browser Steps, mobile Preview gestures, actual Telegram and SMTP delivery in a controlled environment, timeout/process-group recovery under realistic faults, public installation/upgrade/restore acceptance, and a reviewed final functional-parity checklist. Do not merge or cut over solely on CI success.

Security principles: Chromium sandbox, SSRF-aware egress policy, private account security controls, password hashing, encrypted provider/vault data, one owner-scoped persistent volume, no Docker socket mount and no private VPS-specific controller. Public Access is opt-in and intentionally grants anonymous standard workspace functionality; enable only where that behavior is explicitly desired.
