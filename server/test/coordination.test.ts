import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { runMonitor, retainHistory } from "../src/engine.js";
import { migrate } from "../src/migrate.js";
import { dispatch } from "../src/outbox.js";
import { readConfig } from "../src/config.js";
import { acquireChromiumLease } from "../src/chromium-capacity.js";
const cfg = readConfig({
  DATABASE_URL: "postgresql://localhost/fixture",
  JWT_SECRET: randomBytes(32).toString("hex"),
  CHANNEL_KEY: randomBytes(32).toString("hex"),
});
for (const operation of ["monitor", "outbox", "migration"])
  test(`${operation} destroys a database session when unlocking fails, preventing leaked coordination locks`, async () => {
    let destroyed: boolean | undefined;
    const client = {
      query: async (sql: string) => {
        if (sql.includes("pg_advisory_unlock"))
          throw Error("Synthetic unlock failure");
        if (sql.includes("pg_try_advisory_lock"))
          return { rows: [{ locked: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: (destroy: boolean) => {
        destroyed = destroy;
      },
    };
    const pool: any = {
      connect: async () => client,
      query: async () => ({ rows: [{ id: randomUUID() }] }),
    };
    await assert.rejects(
      operation === "monitor"
        ? runMonitor(pool, cfg, randomUUID())
        : operation === "outbox"
          ? dispatch(pool, cfg)
          : migrate(pool),
      /unlock failure/,
    );
    assert.equal(destroyed, true);
  });

test("retention releases its connection if acquiring the cleanup lock fails", async () => {
  let destroyed = false;
  const pool: any = {
    connect: async () => ({
      query: async () => {
        throw Error("Synthetic lock acquisition failure");
      },
      release: (destroy: boolean) => {
        destroyed = destroy;
      },
    }),
  };
  await assert.rejects(retainHistory(pool, cfg), /lock acquisition failure/);
  assert.equal(destroyed, true);
});

test("failed transaction rollback destroys the database connection and preserves the original safe error", async () => {
  const { transaction } = await import("../src/db.js");
  let destroyed: unknown;
  const c = {
    query: async (sql: string) => {
      if (sql === "ROLLBACK") throw Error("connection lost");
      return { rows: [] };
    },
    release: (value: unknown) => {
      destroyed = value;
    },
  };
  const original = Error("synthetic transaction failure");
  await assert.rejects(
    transaction({ connect: async () => c } as any, async () => {
      throw original;
    }),
    (e) => e === original,
  );
  assert.equal(destroyed, true);
});

test("Chromium admission destroys an uncertain database session after lock failure", async () => {
  let destroyed: unknown;
  const pool = { connect: async () => ({
    query: async () => { throw Error("synthetic admission failure"); },
    release: (value: unknown) => { destroyed = value; },
  }) } as any;
  await assert.rejects(acquireChromiumLease(pool, { workload: "preview", slots: 1 }), /admission failure/);
  assert.equal(destroyed, true);
});
