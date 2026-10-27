# Chromium quarantine recovery (operator-assisted, offline)

This is a safety procedure, not an automatic startup unlock. Do not run it on
production without a separate maintenance authorization. The application does
not mount Docker's socket, run a privileged daemon, kill host processes or modify
the deployment controller. A lease timeout, PID not found in another container,
empty `pg_locks`, expired intent or restarted Node process is **not** fencing proof.

## When recovery is necessary

The live owner detects a failed/overdue PostgreSQL heartbeat, aborts Chromium,
closes browser/proxy and clears only its own durable token. This normally recovers
automatically once cleanup and database writes succeed. A one-second client-side
heartbeat deadline also detects a stalled database/partition. Other database
queries have a ten-second client deadline. Neither deadline unlocks capacity.

SIGKILL, a whole-container crash, database outage during cleanup, or a cleanup
watchdog failure can leave `fusion_chromium_scheduler.active_token` quarantined.
New browsers receive bounded HTTP/stage/code/request-ID diagnostics with
`cleanup_timeout`; non-browser monitoring and notification delivery can continue
when PostgreSQL is available. Restarting an owner is not automatic recovery.

Docker `init: true` reaps children; it is not a cross-container fencing authority.
A surviving parent-independent browser can outlive an application process. A
container's **confirmed full termination**, with restart mechanisms held stopped,
is lifecycle evidence that its PID namespace/process tree has terminated. Inspect
running/restarting/paused/created/dead/unknown containers conservatively: none is
accepted as proof by the recovery tool.

## Preconditions — all are mandatory

1. Establish authorized maintenance. Pause the deployment controller, external
   schedulers and every mechanism that could start an API, Worker or migration
   replica. This tool cannot pause or verify external controllers; the operator
   must establish and attest this precondition independently.
2. Inventory **all** processes sharing this PostgreSQL database and capture
   artifacts, including old containers and other Docker hosts/projects. This tool
   supports one local Docker daemon and one Compose project only. If any replica
   is on another daemon/project, unlabelled, on a bare host, or its provenance is
   uncertain, **STOP**: the tool cannot establish a complete fencing scope. The
   tool also rejects privileged/shared-PID runtime containers and unknown service
   labels; do not relax those checks to admit an unreviewed deployment topology.
3. Stop/fence every API/Worker/migrate replica through its authorized supervisor;
   confirm full container termination. Disable their automatic restart policies
   for the maintenance window. Do not merely kill Node, detach a client, stop
   PostgreSQL, or clear an advisory lock. Do not delete old containers before
   recording and verifying evidence. Do not kill arbitrary processes.
4. Ensure PostgreSQL has recovered normally, with one authoritative primary (no
   split brain or stale failover). Inspect the current durable token, migration
   ledger and manual queue. PostgreSQL transaction recovery must finish first;
   an already committed capture/manual result remains committed. Never reset
   baselines, History, health, notifications or queued/running manual requests.
5. Record the local Docker daemon ID (`docker info --format '{{.ID}}'`), Compose
   project, and full IDs of **every** labelled API/Worker/migrate container, including
   exited historical replicas. Inspect only lifecycle fields; never dump secrets.
   Record `SELECT active_token,active_workload,active_since FROM
   fusion_chromium_scheduler WHERE id=1` using existing authorized DB access.

## Explicit recovery command

Use the compiled backend from the reviewed single-slot revision on the trusted
Docker host, with existing `DATABASE_URL` supplied securely in its environment.
Do not pass credentials on the command line, install new credentials or mount
Docker's socket into the application. The host needs its existing Docker CLI
and database authorization. Run the tool only after the preconditions above:

```text
node server/dist/chromium-recovery.js \
  --confirm-all-replicas-fenced --confirm-controllers-paused \
  EXPECTED_QUARANTINE_UUID EXPECTED_DOCKER_DAEMON_ID COMPOSE_PROJECT \
  FULL_CONTAINER_ID_1,FULL_CONTAINER_ID_2
```

The tool performs read-only Docker inspections on the explicit local Unix socket.
It rejects a wrong daemon, incomplete replica inventory, live/ambiguous container,
nonzero container PID, non-exited lifecycle or enabled automatic restart policy.
It takes transaction-scoped advisory locks for CHFE slots 0–4 (including legacy
protocols), locks the singleton row and requires the **exact** expected token.
It then verifies lifecycle evidence while holding these locks and conditionally
clears only that quarantine plus abandoned priority bookkeeping. Manual runs,
monitor health, baselines, captures, History, cooldown/digest/outbox are untouched.
Any failed check rolls back. A commit response lost to a database outage is
ambiguous: inspect the authoritative token before any retry. Never assume that
an error or success message alone establishes the entire maintenance outcome.

The operator confirmations are real trust prerequisites, not automatically
verified facts. Docker cannot prove that an undeclared second host has no browser
or prevent a separate deployment controller from creating a new replica after
inspection. The tool is **not** a general automatic supervisor integration.

After success, retain the evidence in the operator's private maintenance record.
Start only matching API/Worker revisions implementing this protocol, verify one
browser admission and queue recovery, then restore the approved supervisor policy.
Unfinished durable manual checks are retried; committed requests are not replayed.
Observe scheduled monitoring resume without resetting next_run or baselines.

## Migration, rollout and rollback gate

Migration 016 is transactional/additive; 001–015 remain unchanged. The CHECK
replacement requires an exclusive table lock and validates existing History;
its duration depends on table size and must be assessed before deployment.
Fresh install, populated upgrade,
repeated migration and checksum rejection must pass before rollout.

**Automatic mixed-version rollback is unsafe.** The previously committed PR32
image uses CHFE/1 for captures and CHFE/4 for Preview and ignores the durable
fence. Master uses its older gate/slot protocol, also without the durable fence.
The schema cannot make either old binary obey the new quarantine. Database
grants cannot distinguish old and new binaries using the same application role.
An old image could therefore launch while a surviving browser is quarantined.

The private `/opt/changd-fusion/private/deploy.py` is not in this repository and
was not accessed or changed. CI gating, migration guard and coordinated service
ordering alone do not prove that a failed rollout cannot automatically restart
old admission code. Its owner must confirm that migration 016 is accepted, all
old replicas/trees are fenced before startup, and rollback pauses for verified
cleanup before selecting an approved **single-slot** image. API and Worker must
use the same revision. Until this is established, **merge/deployment is NO-GO**.
Do not remove the controller's migration/rollback safeguards to bypass this gate.

Rollback retains migration 016, skipped History and durable manual requests.
Never delete those tables/events or mutate applied migration checksums. Older
software does not process the manual queue, so keep it intact for re-upgrade and
explicitly communicate unavailable manual status. Back up PostgreSQL and capture
artifacts consistently before authorized maintenance. No production operation is
performed by the development or test workflow.
