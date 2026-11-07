import assert from "node:assert/strict";
import test from "node:test";
import { ciEvidenceAtPublication, selectCiRun, verifyCiGate } from "./ghcr-ci-gate.mjs";

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

test("historical CI is bound to a completed release publisher, not later cancelled runs", () => {
  const successful = run({ id: 42338055848, created_at: "2026-11-07T04:20:58Z", updated_at: "2026-11-07T04:25:21Z" });
  const cancelled = run({ id: 42351306900, created_at: "2026-11-07T07:26:43Z", updated_at: "2026-11-07T07:27:39Z", conclusion: "cancelled" });
  const document = runs(cancelled, successful);
  assert.throws(() => selectCiRun(document, sha), /not successful/);
  const historical = ciEvidenceAtPublication(document, sha, "2026-11-07T04:25:23Z");
  assert.equal(verifyCiGate(historical, jobs(), sha).id, successful.id);
  assert.deepEqual(historical.workflow_runs.map((r) => r.id), [successful.id]);
});

test("historical CI fails closed for failed CI at publication and invalid timestamps", () => {
  const successful = run({ id: 1, created_at: "2026-11-07T04:20:58Z", updated_at: "2026-11-07T04:25:10Z" });
  const newerFailure = run({ id: 2, created_at: "2026-11-07T04:25:11Z", updated_at: "2026-11-07T04:25:20Z", conclusion: "failure" });
  const snapshot = ciEvidenceAtPublication(runs(successful, newerFailure), sha, "2026-11-07T04:25:23Z");
  assert.throws(() => verifyCiGate(snapshot, jobs(), sha), /not successful/);
  assert.throws(() => ciEvidenceAtPublication(runs(successful), sha, "invalid"), /invalid_historical_ci_scope/);
  assert.throws(() => ciEvidenceAtPublication(runs(successful, newerFailure), sha, "2026-11-07T04:20:00Z"), /historical_ci_evidence_missing/);
  assert.throws(() => ciEvidenceAtPublication(runs(run({ updated_at: "invalid" })), sha, "2026-11-07T04:25:23Z"), /historical_ci_time_unverified/);
  assert.throws(() => ciEvidenceAtPublication({ total_count: 9, workflow_runs: [successful] }, sha, "2026-11-07T04:25:23Z"), /historical_ci_evidence_incomplete/);
  assert.throws(() => ciEvidenceAtPublication(runs(run({ id: 3, created_at: "2026-11-07T04:20:58Z", updated_at: "2026-11-07T07:27:39Z" })), sha, "2026-11-07T04:25:23Z"), /historical_ci_evidence_missing/);
});
