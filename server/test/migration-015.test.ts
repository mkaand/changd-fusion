import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("migration 015 adds browser controls and preserves legacy failure alert intent", async () => {
  const sql = await readFile(new URL("../migrations/015_browser_experience_controls.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN monitor_http_error_pages boolean NOT NULL DEFAULT false/);
  assert.match(sql, /ADD COLUMN http_status integer NULL CHECK \(http_status BETWEEN 100 AND 599\)/);
  assert.match(sql, /failure_alert_mode IN \('off', 'first_or_persistent', 'every'\)/);
  assert.match(sql, /WHERE notify_failures/);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
});
