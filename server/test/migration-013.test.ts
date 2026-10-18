import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("migration 013 adds selected-area capture without rewriting existing monitor data", async () => {
  const sql = await readFile(new URL("../migrations/013_selected_area_capture.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN capture_area jsonb/);
  assert.match(sql, /'viewport', 'full_page', 'element', 'selected_area'/);
  assert.match(sql, /capture_mode = 'selected_area'.+capture_area IS NOT NULL/);
  assert.match(sql, /width'\)::numeric >= 16/);
  assert.match(sql, /height'\)::numeric >= 16/);
  assert.match(sql, /<= 1280/);
  assert.match(sql, /<= 900/);
  assert.doesNotMatch(sql, /\bUPDATE\s+fusion_monitors\b/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
});
