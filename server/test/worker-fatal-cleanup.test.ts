import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { readConfig } from "../src/config.js";
import { WorkerFatalError } from "../src/errors.js";
import { runMonitor } from "../src/engine.js";

const cfg = readConfig({
  DATABASE_URL: "postgresql://localhost/fixture",
  JWT_SECRET: randomBytes(32).toString("hex"),
  CHANNEL_KEY: randomBytes(32).toString("hex"),
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
