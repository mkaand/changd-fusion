import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("migration 014 adds bounded per-monitor timeouts without rewriting existing monitors", async () => {
  const sql = await readFile(new URL("../migrations/014_per_monitor_capture_timeout.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN capture_timeout_ms integer/);
  assert.match(sql, /30000, 45000, 60000, 75000, 90000/);
  assert.match(sql, /capture_timeout_ms IS NULL/);
  assert.doesNotMatch(sql, /\bUPDATE\s+fusion_monitors\b/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
});
