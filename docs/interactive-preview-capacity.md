# Interactive Preview capacity (0.3.0)

The API Preview lane and scheduled capture lane each reserve **one** PostgreSQL
session advisory lock, across all replicas using the same database. Capture uses
the existing CHFE/1 key; Preview uses CHFE/4. `CHROMIUM_CONCURRENCY=1` remains the
deployment setting. Larger legacy slot settings cannot multiply either lane.
The global upper bound is two Chromium process trees, one per workload.

Scheduled work never waits for Preview admission; Preview never waits for a
scheduled capture. A genuinely occupied Preview lane returns HTTP 429 after at
most one second of admission polling, even with a legacy 45000 ms setting.
PostgreSQL connection/query failures have their own existing bounded deadlines;
the one-second polling bound is not a guarantee about an unavailable database.
Waiters release database clients between probes, and the API keeps its existing
four-request admission bound. Browser execution retains the monitor deadline,
the 110-second total transport budget, and the absolute 45-second session TTL.

## Resource evidence

Compose budgets are unchanged:

| Lane | CPU ceiling | RAM | PIDs | SHM |
| --- | --- | --- | --- | --- |
| API / interactive | 0.75 | 640 MiB | 192 | 64 MiB |
| Worker / scheduled | 1 | 1024 MiB | 256 | 256 MiB |
| Combined reservation | 1.75 | 1664 MiB | 448 | 320 MiB |

`node scripts/interactive-capacity-smoke.mjs` runs both lanes concurrently in
isolated rootless containers with these exact limits and the checked-in seccomp
profile. An amd64 synthetic run measured 296468480 bytes / 121 PIDs for Preview
and 314462208 bytes / 130 PIDs for capture, with zero OOM kills. CPU throttling
remained active. These are fixture measurements, not guarantees for arbitrary
websites. Chromium/image limits and container ceilings remain authoritative.
Before deployment, reserve the combined budgets plus PostgreSQL, UI, kernel,
page cache and other applications' existing reservations. A constrained VPS must
not enable this architecture without that headroom. No production sizing or
deployment has been performed.

The smoke fixture uses a bounded 128 MiB `/tmp` tmpfs to avoid transient disk
exhaustion from the Cloud executor's VFS image copies. That memory is charged
inside the same container RAM ceiling; no application resource ceiling is
raised and production Compose mounts are unchanged. Deployment also needs free
disk space for Chromium profiles and capture artifacts.

## Lifecycle and failure handling

Leases live on dedicated database connections until confirmed browser/proxy
cleanup. Client disconnect and expiry close Preview resources; cached images
are labelled as previous captures and cannot generate live selectors. Valid
owner-bound sessions reuse the same browser and original expiry.
Session state remains API-process-local; API replicas need request affinity for
reuse (a request routed elsewhere fails safely as expired).
Lease connection loss aborts active browser work. Process death releases its PostgreSQL locks;
container restart must also terminate its old Chromium children (`init: true`).
Cleanup watchdog failures quarantine the lease until supervised API restart,
rather than advertising capacity while a browser may still be alive.

Deploy API and Worker from the same image version together: mixed legacy/new
admission protocols are unsupported. For a PostgreSQL restart or network
partition, stop/restart API and Worker together before accepting new work; advisory
locks cannot fence an old browser through a database outage. This is a release
constraint, not an instruction to operate production from this task.

Preview is optional. Desktop panels do not block manual form inputs or Save;
mobile Back cancels work and returns to the preserved editor draft. Selected
Text uses Jina Reader, not Chromium, and consumes neither browser lane.
HTTP status, safe stage/code and request ID are retained when provided by the
server. Non-JSON proxy failures are labelled as transport failures; explicit
cancellation, expired sessions and server timeouts have different codes.
Native iPhone Safari acceptance and complex-site resource behavior remain manual
release checks. Source SHA/version continue to use the existing build provenance
helper; frontend and backend package/lockfile versions are synchronized to 0.3.0.
