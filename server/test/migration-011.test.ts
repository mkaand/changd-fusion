import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("migration 011 retires Product Price with a new baseline instead of a silent comparison", async () => {
  const sql = await readFile(new URL("../migrations/011_public_access_security.sql", import.meta.url), "utf8");
  assert.match(sql, /WHERE extraction_mode='product_price'/);
  assert.match(sql, /baseline_id=NULL/);
  assert.match(sql, /latest_capture_id=NULL/);
  assert.match(sql, /monitor_state=CASE WHEN NOT enabled THEN 'disabled' WHEN paused THEN 'paused' ELSE 'waiting_baseline' END/);
  assert.match(sql, /SELECT id,'extraction_transition',true FROM transitioned/);
});
