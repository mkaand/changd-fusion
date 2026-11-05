import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeploymentStateStore } from "./deployment-state.mjs";

const project = "fusion_state_test";
const release = { version: "0.3.3", source_sha: "a".repeat(40), api_image: `ghcr.io/mkaand/changd-fusion-api@sha256:${"b".repeat(64)}`, ui_image: `ghcr.io/mkaand/changd-fusion-ui@sha256:${"c".repeat(64)}` };
let directory;
test.beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "fusion-state-")); await (await import("node:fs/promises")).chmod(directory, 0o700); });
test.afterEach(() => rm(directory, { recursive: true, force: true }));

test("atomically persists secure state, previous release and notification identity", async () => {
  const store = new DeploymentStateStore({ directory, project, now: () => 1000 });
  assert.equal(store.acquire(), true); assert.equal(store.acquire(), false);
  let state = store.load();
  state = store.transition(state, "PREPARING", { operation_id: "11111111-1111-4111-8111-111111111111", candidate: release });
  state = store.transition(state, "DRAINING");
  state = store.transition(state, "DEPLOYING");
  state = store.transition(state, "VERIFYING");
  state = store.transition(state, "SUCCESS", { previous: state.current, current: release, candidate: null, failure: null });
  state = store.markNotification(state, state.operation_id);
  assert.equal(store.load().notification.success_operation, state.operation_id);
  assert.equal((await stat(path.join(directory, "deployment-state.json"))).mode & 0o777, 0o600);
  store.release(); assert.equal(store.acquire(), true); store.release();
});

test("interrupted state becomes recovery-required and malformed or truncated state fails closed", async () => {
  const store = new DeploymentStateStore({ directory, project });
  let state = store.transition(store.load(), "PREPARING", { operation_id: "22222222-2222-4222-8222-222222222222", candidate: release });
  state = store.transition(state, "DRAINING");
  state = store.transition(state, "DEPLOYING");
  state = store.reconcile(store.load());
  assert.equal(state.status, "RECOVERY_REQUIRED");
  await writeFile(path.join(directory, "deployment-state.json"), "{", { mode: 0o600 });
  assert.throws(() => store.load(), /invalid_deployment_state/);
});

test("wrong project, inconsistent success and insecure state files are rejected", async () => {
  const store = new DeploymentStateStore({ directory, project });
  const state = store.transition(store.load(), "PREPARING", { operation_id: "33333333-3333-4333-8333-333333333333", candidate: release });
  const raw = JSON.parse(await readFile(path.join(directory, "deployment-state.json"), "utf8"));
  await writeFile(path.join(directory, "deployment-state.json"), JSON.stringify({ ...raw, project: "other" }), { mode: 0o600 });
  assert.throws(() => store.load(), /invalid_deployment_state/);
  await writeFile(path.join(directory, "deployment-state.json"), JSON.stringify({ ...state, status: "SUCCESS", candidate: release, current: null }), { mode: 0o644 });
  await chmod(path.join(directory, "deployment-state.json"), 0o644);
  assert.throws(() => store.load(), /unsafe_state_file/);
});

test("rejects out-of-order lifecycle transitions and malformed failure metadata", () => {
  const store = new DeploymentStateStore({ directory, project });
  assert.throws(() => store.transition(store.load(), "SUCCESS", { current: release }), /invalid_deployment_transition/);
  assert.throws(() => store.write({ ...store.initial(), status: "FAILED", failure: { code: "bad value", stage: "test" } }), /invalid_deployment_state/);
});

test("a crash after durable health success but before barrier release requires recovery", () => {
  const store = new DeploymentStateStore({ directory, project });
  let state = store.transition(store.load(), "PREPARING", { operation_id: "44444444-4444-4444-8444-444444444444", candidate: release });
  state = store.transition(state, "DRAINING"); state = store.transition(state, "DEPLOYING"); state = store.transition(state, "VERIFYING");
  state = store.transition(state, "SUCCESS", { current: release, candidate: null, maintenance_released: false });
  const recovered = store.reconcile(state);
  assert.equal(recovered.status, "RECOVERY_REQUIRED");
  assert.equal(recovered.maintenance_released, false);
});
