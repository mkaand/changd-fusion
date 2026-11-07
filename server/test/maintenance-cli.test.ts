import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { runMaintenanceCli } from "../src/maintenance-cli.js";

test("bootstrap-status finishes pending PostgreSQL queries before closing the pool", async () => {
  const project = "changd-fusion-v030";
  const sourceSha = "a".repeat(40);
  const confirmedAt = new Date("2026-11-05T06:45:12.000Z");
  let closed = false;
  let queryCount = 0;

  const pool = {
    async query(sql: string) {
      // Simulate async PostgreSQL I/O: pool.end() must not race this query.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closed, false, "database pool closed while query was in flight");
      queryCount++;
      if (sql.includes("FROM fusion_migrations")) return { rowCount: 2 };
      if (sql.includes("FROM fusion_updater_bootstrap")) {
        return { rows: [{ project, source_sha: sourceSha, confirmed_at: confirmedAt }] };
      }
      throw Error("unexpected_query");
    },
    async end() { closed = true; },
  } as unknown as Pool;

  const result = await runMaintenanceCli("bootstrap-status", { project }, pool);

  assert.deepEqual(result, {
    bootstrapped: true,
    project,
    source_sha: sourceSha,
    confirmed_at: confirmedAt.toISOString(),
  });
  assert.equal(queryCount, 2);
  assert.equal(closed, true);
});
