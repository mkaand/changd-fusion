import assert from "node:assert/strict";
import test from "node:test";
import { verifiedSourcePr } from "./source-pr-metadata.mjs";
const sha = "a".repeat(40);
const valid = { number: 38, state: "closed", merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: sha, base: { ref: "master", repo: { full_name: "mkaand/changd-fusion" } } };
test("accepts one exact merged master PR", () => assert.equal(verifiedSourcePr([valid], sha), "38"));
test("rejects missing, ambiguous and malformed provenance", () => {
  assert.equal(verifiedSourcePr([], sha), "");
  assert.equal(verifiedSourcePr([valid, { ...valid, number: 39 }], sha), "");
  assert.equal(verifiedSourcePr([{ ...valid, merged_at: null }], sha), "");
  assert.equal(verifiedSourcePr([{ ...valid, merge_commit_sha: "b".repeat(40) }], sha), "");
});
