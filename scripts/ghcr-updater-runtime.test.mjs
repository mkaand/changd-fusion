import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeploymentStateStore } from "./deployment-state.mjs";
import { executeUpdaterRuntime, runtimeConfiguration } from "./ghcr-updater-runtime.mjs";

const project = "fusion_runtime_test";
const source = "a".repeat(40), oldSource = "d".repeat(40);
const api = `ghcr.io/mkaand/changd-fusion-api@sha256:${"b".repeat(64)}`;
const ui = `ghcr.io/mkaand/changd-fusion-ui@sha256:${"c".repeat(64)}`;
const oldApi = `ghcr.io/mkaand/changd-fusion-api@sha256:${"e".repeat(64)}`;
const oldUi = `ghcr.io/mkaand/changd-fusion-ui@sha256:${"f".repeat(64)}`;
const migrations = [{ name: "018_updater_bootstrap.sql", sha256: "1".repeat(64) }];
const manifest = { source_sha: source, version: "0.3.3", api_image: api, ui_image: ui,
  api_worker_shared_image: api, architecture: "linux/amd64", migrations };
const run = { id: 10, name: "GHCR immutable release", path: ".github/workflows/ghcr-release.yml", status: "completed",
  conclusion: "success", head_sha: source, head_branch: "master", run_attempt: 1, repository: "mkaand/changd-fusion" };
const client = { runs: async () => [run], manifest: async () => manifest,
  ci: async () => ({ verify: "success", privacy: "success", docker: "success", "docker-arm64": "success" }),
  masterLineage: async () => true, attestation: async () => ({ attested: true, revision: source, version: "0.3.3" }) };
const environment = (directory) => ({ FUSION_COMPOSE_PROJECT: project, FUSION_PROJECT_DIRECTORY: directory,
  FUSION_COMPOSE_BASE_FILE: path.join(directory, "compose.yml"),
  FUSION_COMPOSE_OVERRIDE_FILE: path.join(directory, "docker-compose.ghcr.yml"),
  FUSION_UPDATER_STATE_DIRECTORY: path.join(directory, "state"), FUSION_COMPOSE_ENV_FILE: path.join(directory, "fixture.env"),
  FUSION_UPDATER_DRY_RUN: "0" });
const baseline = { migrations, monitor_count: 2, enabled_count: 1, paused_count: 1, baseline_count: 2,
  event_count: 3, capture_count: 4, monitor_signature: "9".repeat(64) };

function fixtures(directory, overrides = {}) {
  const actions = [], notifications = [];
  const docker = {
    projectIsExpected: async () => true,
    runtimeIdentity: () => ({ version: "0.3.2", source_sha: oldSource, api_image: oldApi, ui_image: oldUi }),
    captureBaseline: async () => baseline,
    safeDrain: async () => true,
    compose: async (_project, args) => { actions.push(args); },
    verifyDeploymentHealth: async () => true,
    completeDrain: () => actions.push(["complete-drain"]),
    ...overrides.docker,
  };
  const maintenance = {
    bootstrapStatus: async () => ({ bootstrapped: true }),
    drain: async ({ project: drainProject, sourceSha, operationId }) => ({ id: operationId, operation_id: operationId,
      project: drainProject, source_sha: sourceSha, issued_at: Date.now() - 1, expires_at: Date.now() + 60_000,
      owner_token: "x".repeat(43) }),
    resume: async () => true, fail: async () => true,
    ...overrides.maintenance,
  };
  const telegram = { send: async (kind, payload) => { notifications.push({ kind, payload }); return { delivered: true }; }, ...overrides.telegram };
  const stateStore = new DeploymentStateStore({ directory: path.join(directory, "state"), project });
  return { actions, notifications, docker, maintenance, telegram, stateStore };
}

let directory;
test.beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "fusion-runtime-")); await chmod(directory, 0o700); });
test.afterEach(() => rm(directory, { recursive: true, force: true }));

test("connects discovery, atomic state, drain, deployment, health, resume and one success notification", async () => {
  const f = fixtures(directory);
  const result = await executeUpdaterRuntime({ environment: environment(directory), client, ...f });
  assert.equal(result.updated, true);
  assert.deepEqual(f.actions.slice(0, 2), [["pull", "api", "worker", "ui"], ["up", "-d", "--no-deps", "--no-build", "api", "worker", "ui"]]);
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].kind, "success");
  const state = f.stateStore.load();
  assert.equal(state.status, "SUCCESS"); assert.equal(state.current.source_sha, source);
  assert.equal(state.maintenance_released, true);
  assert.equal(state.previous.source_sha, oldSource); assert.equal(state.notification.success_operation, state.operation_id);
});

test("unbootstrapped v0.3.2 fails before runtime identity or Docker mutation", async () => {
  let runtimeCalls = 0;
  const f = fixtures(directory, { docker: { runtimeIdentity: () => { runtimeCalls++; throw Error("must_not_run"); } },
    maintenance: { bootstrapStatus: async () => ({ bootstrapped: false, reason: "manual_bootstrap_required" }) } });
  const result = await executeUpdaterRuntime({ environment: environment(directory), client, ...f });
  assert.equal(result.reason, "BOOTSTRAP_REQUIRED"); assert.equal(runtimeCalls, 0); assert.equal(f.actions.length, 0);
  assert.equal(f.stateStore.load().status, "FAILED");
});

test("health failure retains maintenance and durable recovery-required state", async () => {
  let failed = 0, resumed = 0;
  const f = fixtures(directory, { docker: { verifyDeploymentHealth: async () => false },
    maintenance: { fail: async () => { failed++; return true; }, resume: async () => { resumed++; return true; } } });
  const result = await executeUpdaterRuntime({ environment: environment(directory), client, ...f });
  assert.equal(result.reason, "healthcheck_failed"); assert.equal(failed, 1); assert.equal(resumed, 0);
  assert.equal(f.stateStore.load().status, "RECOVERY_REQUIRED");
});

test("atomic SUCCESS write failure retains the barrier and records recovery-required", async () => {
  let failed = 0;
  const f = fixtures(directory, { maintenance: { fail: async () => { failed++; return true; } } });
  const transition = f.stateStore.transition.bind(f.stateStore);
  let injected = false;
  f.stateStore.transition = (state, status, changes) => {
    if (status === "SUCCESS" && !injected) { injected = true; throw Error("fixture_fsync_failure"); }
    return transition(state, status, changes);
  };
  const result = await executeUpdaterRuntime({ environment: environment(directory), client, ...f });
  assert.equal(result.reason, "deployment_failed"); assert.equal(failed, 1);
  assert.equal(f.stateStore.load().status, "RECOVERY_REQUIRED");
});

test("migration ledger drift fails before drain or Compose mutation", async () => {
  let drains = 0;
  const changedClient = { ...client, manifest: async () => ({ ...manifest,
    migrations: [{ name: "019_unreviewed.sql", sha256: "2".repeat(64) }] }) };
  const f = fixtures(directory, { maintenance: { drain: async () => { drains++; throw Error("must_not_drain"); } } });
  const result = await executeUpdaterRuntime({ environment: environment(directory), client: changedClient, ...f });
  assert.equal(result.reason, "unsafe_migration"); assert.equal(drains, 0); assert.equal(f.actions.length, 0);
});

test("migration changes racing the drain fail closed before Compose mutation", async () => {
  let snapshots = 0, retained = 0;
  const f = fixtures(directory, { docker: { captureBaseline: async () => (++snapshots === 1 ? baseline : {
    ...baseline, migrations: [{ name: "019_raced.sql", sha256: "3".repeat(64) }],
  }) }, maintenance: { fail: async () => { retained++; return true; } } });
  const result = await executeUpdaterRuntime({ environment: environment(directory), client, ...f });
  assert.equal(result.reason, "unsafe_migration"); assert.equal(retained, 1); assert.equal(f.actions.length, 0);
  assert.equal(f.stateStore.load().status, "RECOVERY_REQUIRED");
});

test("Telegram delivery failure cannot corrupt a verified successful deployment", async () => {
  const f = fixtures(directory, { telegram: { send: async () => { throw Error("secret transport failure"); } } });
  const result = await executeUpdaterRuntime({ environment: environment(directory), client, ...f });
  assert.equal(result.updated, true); const state = f.stateStore.load();
  assert.equal(state.status, "SUCCESS"); assert.equal(state.notification.error, "telegram_delivery_failed");
});

test("dry-run and no-update have no Docker mutation and no notification", async () => {
  const f = fixtures(directory);
  const dry = await executeUpdaterRuntime({ environment: { ...environment(directory), FUSION_UPDATER_DRY_RUN: "1" }, client, ...f });
  assert.equal(dry.dryRun, true); assert.equal(f.actions.length, 0); assert.equal(f.notifications.length, 0);
  const empty = { ...client, runs: async () => [] };
  const none = await executeUpdaterRuntime({ environment: environment(directory), client: empty, ...fixtures(directory) });
  assert.equal(none.reason, "no_update");
});

test("interrupted state is reconciled fail-closed before mutation", async () => {
  const f = fixtures(directory);
  let state = f.stateStore.transition(f.stateStore.load(), "PREPARING", { operation_id: "11111111-1111-4111-8111-111111111111", candidate: manifest });
  state = f.stateStore.transition(state, "DRAINING");
  const result = await executeUpdaterRuntime({ environment: environment(directory), client, ...f });
  assert.equal(result.reason, "recovery_required"); assert.equal(f.actions.length, 0);
  assert.equal(f.stateStore.load().status, "RECOVERY_REQUIRED");
  assert.equal(f.notifications.filter((entry) => entry.kind === "recovery_required").length, 1);
  await executeUpdaterRuntime({ environment: environment(directory), client, ...f });
  assert.equal(f.notifications.filter((entry) => entry.kind === "recovery_required").length, 1, "recovery alert is operation-deduplicated");
  assert.match(await readFile(path.join(directory, "state", "deployment-state.json"), "utf8"), /interrupted_deployment/);
});

test("interrupted state is detected even when discovery reports no release", async () => {
  const f = fixtures(directory);
  f.stateStore.transition(f.stateStore.load(), "PREPARING", { operation_id: "55555555-5555-4555-8555-555555555555", candidate: manifest });
  const result = await executeUpdaterRuntime({ environment: environment(directory), client: { ...client, runs: async () => [] }, ...f });
  assert.equal(result.reason, "recovery_required"); assert.equal(f.stateStore.load().status, "RECOVERY_REQUIRED");
});

test("operation lock rejects a concurrent runtime before discovery or mutation", async () => {
  const f = fixtures(directory); let discoveries = 0;
  assert.equal(f.stateStore.acquire(), true);
  try {
    const result = await executeUpdaterRuntime({ environment: environment(directory), client: { ...client,
      runs: async () => { discoveries++; return [run]; } }, ...f });
    assert.equal(result.reason, "concurrent_updater"); assert.equal(discoveries, 0); assert.equal(f.actions.length, 0);
  } finally { f.stateStore.release(); }
});

test("runtime configuration fails closed on ambiguous mutation mode, relative paths and foreign trust", () => {
  const valid = environment(directory);
  assert.equal(runtimeConfiguration(valid).dryRun, false);
  for (const changed of [{ FUSION_UPDATER_DRY_RUN: "true" }, { FUSION_COMPOSE_ENV_FILE: "relative.env" },
    { FUSION_COMPOSE_BASE_FILE: "compose.yml" }, { FUSION_COMPOSE_OVERRIDE_FILE: "override.yml" },
    { FUSION_TRUSTED_REPOSITORY: "foreign/project" }]) {
    assert.throws(() => runtimeConfiguration({ ...valid, ...changed }), /invalid_updater_configuration/);
  }
});
