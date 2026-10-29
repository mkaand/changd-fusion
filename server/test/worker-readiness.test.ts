import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MONITOR_WORK_WINDOW_MS,
  OUTBOX_WORK_WINDOW_MS,
  READY_WINDOW_MS,
  WorkerReadiness,
  probeWorkerReadiness,
  type ProbeDependencies,
  type WorkerReadinessMarker,
} from "../src/worker-readiness.js";
import { workerCycle, type WorkerProgressEvent } from "../src/worker.js";

const RELEASE = "1".repeat(40);
const IDENTITY = {
  pid: 41,
  processStartTicks: "123456",
  bootId: "11111111-1111-4111-8111-111111111111",
  instanceId: "22222222-2222-4222-8222-222222222222",
};

function fixture() {
  let now = 1_800_000_000_000;
  let marker: WorkerReadinessMarker | undefined;
  const readiness = new WorkerReadiness(RELEASE, {
    now: () => now,
    identity: IDENTITY,
    write: (value) => { marker = structuredClone(value); },
  });
  const probe = (overrides: Partial<ProbeDependencies> = {}, expected = RELEASE) => {
    const dependencies: ProbeDependencies = {
      now: () => now,
      read: () => JSON.stringify(marker),
      stat: () => ({
        isFile: () => true,
        isSymbolicLink: () => false,
        uid: 1000,
        mode: 0o100600,
        size: 512,
        mtimeMs: marker?.updatedAtMs ?? now,
      }),
      processStartTicks: () => IDENTITY.processStartTicks,
      bootId: () => IDENTITY.bootId,
      uid: () => 1000,
      ...overrides,
    };
    return probeWorkerReadiness("/synthetic/readiness.json", expected, dependencies);
  };
  return { readiness, probe, marker: () => marker!, advance: (ms: number) => { now += ms; } };
}

test("Worker starts not ready and needs initialized loop progress", () => {
  const f = fixture();
  f.readiness.start();
  assert.equal(f.marker().phase, "starting");
  assert.equal(f.probe().ready, false);
  f.readiness.initializedProgress();
  assert.equal(f.probe().ready, true);
  assert.equal(f.marker().phase, "ready");
});

test("idle progress stays fresh without writing on every cycle", () => {
  const f = fixture();
  f.readiness.start();
  f.readiness.initializedProgress();
  const sequence = f.marker().sequence;
  f.advance(1_000);
  f.readiness.cycleSucceeded();
  assert.equal(f.marker().sequence, sequence);
  f.advance(10_000);
  f.readiness.cycleSucceeded();
  assert.equal(f.marker().sequence, sequence + 1);
  assert.equal(f.probe().ready, true);
});

test("bounded monitor work is healthy but cannot remain healthy indefinitely", () => {
  const f = fixture();
  f.readiness.start();
  f.readiness.initializedProgress();
  f.readiness.busy("monitor");
  f.advance(MONITOR_WORK_WINDOW_MS - 1);
  assert.equal(f.probe().ready, true);
  f.advance(2);
  assert.equal(f.probe().ready, false);
});

test("outbox progress renews only its bounded work window", () => {
  const f = fixture();
  f.readiness.start();
  f.readiness.initializedProgress();
  f.readiness.busy("outbox");
  f.advance(OUTBOX_WORK_WINDOW_MS - 1);
  assert.equal(f.probe().ready, true);
  f.readiness.busy("outbox");
  assert.equal(f.probe().ready, true);
});

test("repeated failures become unhealthy and a completed cycle recovers", () => {
  const f = fixture();
  f.readiness.start();
  f.readiness.initializedProgress();
  f.readiness.cycleFailed();
  assert.equal(f.marker().phase, "degraded");
  assert.equal(f.probe().ready, true);
  f.readiness.initializedProgress();
  f.readiness.cycleFailed();
  f.readiness.cycleFailed();
  assert.equal(f.marker().phase, "failed");
  assert.equal(f.probe().ready, false);
  f.readiness.initializedProgress();
  f.readiness.cycleSucceeded();
  assert.equal(f.marker().phase, "ready");
  assert.equal(f.probe().ready, true);
});

test("shutdown and fatal cleanup make readiness immediately negative", () => {
  for (const terminal of ["stopping", "fatal"] as const) {
    const f = fixture();
    f.readiness.start();
    f.readiness.initializedProgress();
    f.readiness[terminal]();
    assert.equal(f.marker().phase, terminal);
    assert.equal(f.probe().ready, false);
    f.readiness.cycleSucceeded();
    assert.equal(f.marker().phase, terminal);
  }
});

test("stale, malformed, missing, wrong-release and failed probes remain negative", () => {
  const f = fixture();
  f.readiness.start();
  f.readiness.initializedProgress();
  assert.equal(f.probe({}, "2".repeat(40)).ready, false);
  assert.equal(f.probe({ read: () => "{" }).ready, false);
  assert.equal(f.probe({ read: () => { throw new Error("missing"); } }).ready, false);
  f.advance(READY_WINDOW_MS + 1);
  assert.equal(f.probe().ready, false);
});

test("process crash, PID reuse, boot change, insecure marker and future timestamp are rejected", () => {
  const f = fixture();
  f.readiness.start();
  f.readiness.initializedProgress();
  assert.equal(f.probe({ processStartTicks: () => { throw new Error("gone"); } }).ready, false);
  assert.equal(f.probe({ processStartTicks: () => "999999" }).ready, false);
  assert.equal(f.probe({ bootId: () => "33333333-3333-4333-8333-333333333333" }).ready, false);
  assert.equal(f.probe({ stat: () => ({ isFile: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o100644, size: 512, mtimeMs: f.marker().updatedAtMs }) }).ready, false);
  f.marker().updatedAtMs += 10_000;
  f.marker().validUntilMs += 10_000;
  assert.equal(f.probe().ready, false);
});

test("new Worker incarnation cannot reuse a prior marker", () => {
  const f = fixture();
  f.readiness.start();
  f.readiness.initializedProgress();
  assert.equal(f.probe({ processStartTicks: () => "654321" }).ready, false);
});

test("Chromium quarantine is not part of Worker readiness", () => {
  const f = fixture();
  f.readiness.start();
  f.readiness.initializedProgress();
  assert.equal(f.probe().ready, true);
  assert.equal(Object.keys(f.marker()).some((key) => key.includes("chromium")), false);
});

test("workerCycle emits initialization and completion without idle heartbeat writes or Chromium", async () => {
  const events: WorkerProgressEvent[] = [];
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("fusion_notification_digests")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool: any = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [], rowCount: 0 };
    },
    connect: async () => client,
  };
  await workerCycle(pool, {
    CHROMIUM_CONCURRENCY: 1,
    CAPTURE_TIMEOUT_MS: 60_000,
    PUBLIC_URL: "https://example.com",
    CHANNEL_KEY: "synthetic",
    DATA_DIR: "/synthetic",
  } as any, {
    capture: async () => { throw new Error("Chromium must not launch"); },
    send: async () => {},
    onProgress: (event) => events.push(event),
  });
  assert.equal(events[0]?.kind, "initialized");
  assert.equal(events.some((event) => event.kind === "outbox-progress"), false);
  assert.equal(events.at(-1)?.kind, "outbox-finished");
});

test("database initialization failure never emits initialized readiness", async () => {
  const events: WorkerProgressEvent[] = [];
  await assert.rejects(workerCycle({ query: async () => { throw new Error("db unavailable"); } } as any, {} as any, {
    onProgress: (event) => events.push(event),
  }));
  assert.equal(events.some((event) => event.kind === "initialized"), false);
});

test("Docker contract embeds immutable revision and local Worker healthcheck", async () => {
  const compose = await readFile(path.resolve(import.meta.dirname, "../../docker-compose.yml"), "utf8");
  const dockerfile = await readFile(path.resolve(import.meta.dirname, "../Dockerfile"), "utf8");
  assert.match(compose, /APP_COMMIT: \$\{APP_COMMIT:-\$\{DEPLOY_SHA:-development\}\}/);
  assert.match(compose, /test: \["CMD", "node", "dist\/worker-healthcheck\.js", "--json"\]/);
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.revision=\$\{APP_COMMIT\}/);
  assert.match(dockerfile, /ENV .*APP_COMMIT=\$\{APP_COMMIT\}/);
});
