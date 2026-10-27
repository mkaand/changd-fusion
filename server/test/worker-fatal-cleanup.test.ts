import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { readConfig } from "../src/config.js";
import { WorkerFatalError, ChromiumCoordinationLost, SchedulingCancellation } from "../src/errors.js";
import { runMonitor } from "../src/engine.js";
import { capture } from "../src/capture.js";

const cfg = readConfig({
  DATABASE_URL: "postgresql://localhost/fixture",
  JWT_SECRET: randomBytes(32).toString("hex"),
  CHANNEL_KEY: randomBytes(32).toString("hex"),
});

test("an already lost Chromium lease retains its typed infrastructure outcome before launch", async () => {
  const controller = new AbortController();
  const reason = new ChromiumCoordinationLost();
  controller.abort(reason);
  await assert.rejects(capture({} as any, cfg, undefined, controller.signal), (error) => error === reason);
});

test("WorkerFatalError bypasses monitor failure state, events, and notifications while locks are cleaned up", async () => {
  const queries: string[] = [];
  let released: unknown;
  const id = randomUUID();
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
      if (sql.includes("SELECT * FROM fusion_monitors")) return { rows: [{ id, enabled: true, paused: false }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: (destroy?: boolean) => { released = destroy; },
  };
  const pool: any = { connect: async () => client };
  await assert.rejects(
    runMonitor(pool, cfg, id, { capture: (async () => { throw new WorkerFatalError("browser"); }) as any }),
    WorkerFatalError,
  );
  assert.equal(queries.some((sql) => sql.includes("failure_count=failure_count+1")), false);
  assert.equal(queries.some((sql) => sql.includes("INSERT INTO fusion_events")), false);
  assert.equal(queries.some((sql) => sql.includes("fusion_outbox")), false);
  assert.equal(queries.some((sql) => sql.includes("pg_advisory_unlock")), true);
  assert.equal(released, false);
});

test("coordination loss and scheduling cancellation never enter the site failure or notification path", async () => {
  for (const cause of [new ChromiumCoordinationLost(), new SchedulingCancellation()]) {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes("SELECT * FROM fusion_monitors")) return { rows: [{ id: "fixture", enabled: true, paused: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }, release() {},
    };
    const operation = runMonitor({ connect: async () => client } as any, cfg, randomUUID(), { capture: async () => { throw cause; } });
    if (cause instanceof SchedulingCancellation) assert.equal(await operation, false);
    else await assert.rejects(operation, ChromiumCoordinationLost);
    assert.equal(queries.some((sql) => sql.includes("failure_count=failure_count+1") || sql.includes("fusion_outbox")), false);
    assert.equal(queries.some((sql) => sql.includes("'skipped'")), cause instanceof SchedulingCancellation);
  }
});
