import assert from "node:assert/strict";
import test from "node:test";
import { verifyCiGate } from "./ghcr-ci-gate.mjs";

const sha = "a".repeat(40);
const required = ["verify", "privacy", "docker", "docker-arm64"];
function run(overrides = {}) {
  return { id: 7, name: "CI", path: ".github/workflows/ci.yml", head_sha: sha, status: "completed", conclusion: "success", run_number: 9, run_attempt: 1, created_at: "2026-10-31T00:00:00Z", ...overrides };
}
function runs(...items) { return { total_count: items.length, workflow_runs: items }; }
function jobs(items = required.map(name => ({ name, status: "completed", conclusion: "success", run_attempt: 1 }))) { return { total_count: items.length, jobs: items }; }

test("accepts all required successful jobs from one latest CI run", () => {
  assert.equal(verifyCiGate(runs(run()), jobs(), sha).id, 7);
});
test("rejects a failed Docker job in the latest CI run", () => {
  assert.throws(() => verifyCiGate(runs(run()), jobs(required.map(name => ({ name, status: "completed", conclusion: name === "docker" ? "failure" : "success", run_attempt: 1 }))), sha), /docker/);
});
test("rejects an older pass masked by a newer CI failure", () => {
  assert.throws(() => verifyCiGate(runs(run({ id: 1, created_at: "2026-10-30T00:00:00Z" }), run({ id: 2, created_at: "2026-10-31T00:00:00Z", conclusion: "failure" })), jobs(), sha), /latest trusted CI workflow run/);
});
test("rejects missing required jobs", () => {
  assert.throws(() => verifyCiGate(runs(run()), jobs(required.slice(0, 3).map(name => ({ name, status: "completed", conclusion: "success", run_attempt: 1 }))), sha), /docker-arm64/);
});
test("does not combine jobs from different run attempts", () => {
  assert.throws(() => verifyCiGate(runs(run({ run_attempt: 2 })), jobs(required.map((name, index) => ({ name, status: "completed", conclusion: "success", run_attempt: index < 3 ? 2 : 1 }))), sha), /docker-arm64/);
});
test("rejects wrong source SHA", () => {
  assert.throws(() => verifyCiGate(runs(run({ head_sha: "b".repeat(40) })), jobs(), sha), /exact source SHA/);
});
test("rejects an incomplete latest workflow run", () => {
  assert.throws(() => verifyCiGate(runs(run({ status: "in_progress", conclusion: null })), jobs(), sha), /not successful/);
});
