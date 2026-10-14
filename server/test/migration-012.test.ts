import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("migration 012 adds keyword presence without rewriting existing monitor data", async () => {
  const sql = await readFile(new URL("../migrations/012_keyword_presence.sql", import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN keyword text/);
  assert.match(sql, /'full_text', 'selected_text', 'keyword_presence'/);
  assert.match(sql, /char_length\(btrim\(keyword\)\) BETWEEN 1 AND 200/);
  assert.match(sql, /extraction_mode <> 'keyword_presence' OR keyword IS NOT NULL/);
  assert.doesNotMatch(sql, /\bUPDATE\s+fusion_monitors\b/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
});
