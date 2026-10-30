# User-first Chromium scheduling (0.3.0)

API and Worker replicas share exactly one CHFE/1 PostgreSQL session advisory lock.
`CHROMIUM_CONCURRENCY=1` is enforced. There is no separate Preview reservation.
An authenticated browser request registers a durable priority intent only after
authorization and target validation. Opening an editor, editing steps, saving,
reading History and viewing a previous screenshot do not register intents.

## Admission and preemption

Pending intents are FIFO, expire absolutely after 20 seconds, and are bounded to
four globally and one per owner. Cancellation cancels the intent. Waiters return
pool connections between probes. Preview admission waits at most 15 seconds,
subject to the existing 110-second transport budget and the browser/proxy cleanup
allowance (a 90-second capture permits at most 10 seconds of admission). This permits a safe handoff,
not a promise of instant admission. An active owner's Preview retains the slot
through its original absolute 45-second session TTL and verified cleanup.

The Worker polls for priority on its lease-owning database connection at 100 ms
intervals, with only one query in flight. A scheduled browser capture receives a
typed `SchedulingCancellation`. Closing its context interrupts active Playwright
operations; browser and proxy close each have the existing five-second watchdog.
Only confirmed cleanup permits release of the shared lease. Pending scheduled
work is deferred five seconds without generating History rows or filling the
next due batch ahead of non-browser checks. Non-browser monitoring,
maintenance and notification delivery do not acquire Chromium capacity.

Interactive bursts cannot extend their initial 60-second priority window through
reconnects. A subsequent request triggers a 30-second scheduled recovery turn;
new interactive registration is retryable during that turn. Scheduled work is
admitted during that turn completes within its normal bounded capture deadline,
even after the admission turn ends. A scheduled capture already active when a
recovery turn begins gains the same completion protection. A quiet gap of at
least 30 seconds after confirmed interactive cleanup permits a fresh burst;
reconnect gaps while Preview still holds the browser cannot reset an expired
window. Existing Preview sessions still close through their bounded owner lifecycle.

## Outcomes and manual checks

Only actual scheduled preemptions produce `skipped`, with
`warning_code=interactive_priority`. Their transaction updates next_run by at
most 30 seconds and inserts the informational event. Health, failure count,
baseline, latest capture, last success and notification records are preserved.
Cancellation before the capture transaction commits rolls back capture/event/
outbox writes. Once commit begins, a successful commit remains successful.

Check now creates a durable manual-run record, deduplicated by an open-request
unique index per monitor. The durable queue is bounded to 16 open requests globally
and four per owner; registration and its priority intent commit atomically.
Browser checks register the same interactive priority;
non-browser checks remain functional without acquiring Chromium. A replacement
Worker retries queued/running records under the existing per-monitor lock.
The manual outcome is committed as completed/failed with the capture outcome.
Disabled/paused requests become cancelled. A queued request may also be cancelled
through DELETE `/api/v1/jobs/:id/run`; a running manual capture must finish within
its normal deadline. GET `/api/v1/jobs/:id/run` exposes the
latest owner-authorized state; the detail UI polls it. Preview and Check now
serialize through the same slot and FIFO queue. Genuine manual failures retain
normal failure diagnostics, backoff and alerts.

## Cleanup fence and verified recovery

The singleton scheduler row holds a durable random owner token while Chromium
may exist. Advisory lock loss alone never clears it. The live owner aborts browser
work on coordination loss, confirms browser/proxy cleanup and clears only its own
token. Cleanup timeout leaves the token quarantined and the Worker watchdog exits
for supervised recovery. This prevents a new browser through a database outage,
process crash or an ambiguous unlock. A one-second client-side heartbeat deadline
detects a stalled database or network partition as well as an explicit disconnect.
General database queries also have a ten-second client-side deadline; no timeout
advertises free capacity.

**Operator-assisted crash recovery:** a dead API/Worker cannot attest to the
death of its Chromium descendants. A replacement process must fail closed while
the durable token remains. Automatic expiry or clearing on startup would violate
the one-tree invariant during partitions or orphaned-browser survival. Recovery
requires independently confirmed termination of every old runtime container/tree.
The offline `server/dist/chromium-recovery.js` tool verifies the declared local
Docker daemon, complete Compose replica inventory, exited/PID-zero containers
and disabled restart policies. Under legacy/new admission locks it clears only
the exact expected token after evidence verification. It never alters monitor,
History, baseline, manual-run or notification state. There is no recovery API,
application Docker socket, privileged daemon or controller change.

The operator must independently establish that all replicas are on the declared
host/project and that external deployment/restart mechanisms are paused. The
tool cannot prove these global administrative facts. This deliberately remains
operator-assisted rather than unsafe automatic expiry. See the detailed
[recovery and rollback runbook](chromium-recovery.md). Automatic recovery from
abrupt owner/container death is not claimed. The production supervisor/rollback
assessment remains a merge/deployment blocker pending the controller owner's
review; isolated Docker evidence is not evidence of production compatibility.

Session state remains API-process-local; replicas require request affinity for
reuse. A request routed elsewhere fails safely as expired. Cached screenshots
are explicitly stale, cannot yield live selectors, and never block manual edits.
Safe HTTP status/stage/code/request-ID diagnostics distinguish transport failures.

## Migration and rollout

One additive migration, 016, adds priority intents, manual-run lifecycle and the
durable scheduler fence, plus the `skipped` event constraint. Existing migrations
001–015 and their checksums are unchanged. The migrator applies each new file in
one transaction under its migration advisory lock; repeat execution validates
the checksum and performs no duplicate writes. Fresh/upgrade integration tests
exercise this behavior. No existing monitor, baseline or notification is rewritten.
The events CHECK replacement takes an exclusive table lock and validates existing
History; duration depends on table size. Assess this before rollout.

API and Worker must deploy from the same revision with all legacy admission
processes stopped and their Chromium trees confirmed gone. Mixed revisions use
different admission protocols and are unsupported. No controller change is made.
The external production migration guard cannot be verified from this repository;
its owner must review migration 016 before authorizing merge/deployment. An
automatic rollback that restarts legacy admission code before verified cleanup
is unsafe: neither old master nor the committed two-lane PR32 image obeys the
durable fence. The additive schema alone cannot enforce a protocol on old binaries.

Rollback keeps the additive schema and History intact; do not drop the new
tables or remove skipped records. An older Worker ignores manual requests and
the durable fence, so rollback also needs a coordinated full API/Worker stop and
confirmed browser cleanup. Back up PostgreSQL and capture artifacts together.
The rejected two-browser PR32 image is not an acceptable rollback target on the
resource-constrained VPS; select a previously validated single-slot revision.
Native iPhone Safari, real-site behavior and actual supervisor recovery remain release
acceptance checks. No production operations are performed by this task.

## Unchanged resource ceilings

| Process | CPU | RAM | PIDs | SHM |
| --- | --- | --- | --- | --- |
| API | 0.75 | 640 MiB | 192 | 64 MiB |
| Worker | 1 | 1024 MiB | 256 | 256 MiB |

Only the current lease owner may run Chromium. The resource smoke exercises API
and Worker browser fixtures sequentially under these exact limits, rootless UID
1000 and the checked-in seccomp profile. PostgreSQL/real-Chromium integration
separately exercises preemption and samples live browser roots during handoff.
`scripts/chromium-crash-smoke.mjs` additionally creates its own isolated PostgreSQL
16.15 and sandboxed Chromium test containers. It exercises real Worker/API actor
SIGKILL, a surviving rootless browser, real cleanup watchdog failure, a crash during
handoff, PostgreSQL pause/restart, fail-closed quarantine and verified container
fencing/exact-token recovery. Its destructive operations target only its own
disposable test containers; existing images, volumes and services are untouched.
The smoke's bounded 128 MiB test-only /tmp tmpfs is charged within the same RAM
ceiling; production mounts and all resource limits are unchanged. Node 24 LTS,
sandbox, SSRF/DNS/TLS safeguards and 0.3.0 package/provenance behavior are retained.
