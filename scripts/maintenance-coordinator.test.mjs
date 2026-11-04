import assert from "node:assert/strict";
import test from "node:test";
import { ComposeMaintenanceCoordinator, createMaintenanceDrainVerifier } from "./maintenance-coordinator.mjs";

const sourceSha = "a".repeat(40);
const evidence = {
  id: "11111111-1111-4111-8111-111111111111",
  operation_id: "11111111-1111-4111-8111-111111111111",
  project: "fusion_test",
  source_sha: sourceSha,
  issued_at: 1000,
  expires_at: 2000,
  owner_token: "x".repeat(43),
};

test("coordinator drives the real maintenance CLI contract and preserves fail-closed results", async () => {
  const calls = [];
  const adapter = { maintenanceExec(action, payload) {
    calls.push({ action, payload });
    if (action === "begin") return JSON.stringify(evidence);
    if (action === "verify") return JSON.stringify({ valid: payload.phase === "authorize" });
    if (action === "resume") return JSON.stringify({ resumed: true });
    return JSON.stringify({ retained: true });
  }, setDrainVerifier(verifier) { this.verifier = verifier; } };
  const coordinator = new ComposeMaintenanceCoordinator({ adapter, timeoutMs: 1000, evidenceTtlMs: 5000 });
  assert.deepEqual(await coordinator.drain({ project: "fusion_test", sourceSha }), evidence);
  assert.equal(await adapter.verifier(evidence, { phase: "authorize" }), true);
  assert.equal(await createMaintenanceDrainVerifier(coordinator)(evidence, { phase: "authorize" }), true);
  assert.equal(await coordinator.verify(evidence, { phase: "assert" }), false);
  assert.equal(await coordinator.resume(evidence), true);
  assert.equal(await coordinator.fail(evidence, "deployment_failed"), true);
  assert.deepEqual(calls.map((call) => call.action), ["begin", "verify", "verify", "verify", "resume", "fail"]);
});

test("coordinator rejects malformed output, invalid identity and unavailable verification", async () => {
  const coordinator = new ComposeMaintenanceCoordinator({ adapter: { maintenanceExec: () => "not-json" } });
  await assert.rejects(coordinator.drain({ project: "bad project", sourceSha }), /invalid_maintenance_identity/);
  assert.equal(await coordinator.verify(evidence, { phase: "assert" }), false);
  await assert.rejects(coordinator.resume(evidence), /invalid_maintenance_response/);
});
