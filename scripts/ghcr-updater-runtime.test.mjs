import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeploymentStateStore } from "./deployment-state.mjs";
import { adoptVerifiedInstalledRuntime, executeUpdaterRuntime, runtimeConfiguration, runtimeOutcome, safeRuntimeFailureCode, validateDockerCliConfiguration } from "./ghcr-updater-runtime.mjs";

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


test("same-version master release requires live ancestry proof and causes no dry-run mutations", async () => {
  const calls = [];
  const f = fixtures(directory, { docker: {
    runtimeIdentity: () => ({
      version: manifest.version, source_sha: oldSource, api_image: oldApi, ui_image: oldUi,
    }),
  } });
  const withLineage = { ...client,
    sourceLineage: async (installed, candidate) => {
      calls.push({ installed, candidate });
      return true;
    },
  };
  const result = await executeUpdaterRuntime({
    environment: { ...environment(directory), FUSION_UPDATER_DRY_RUN: "1" },
    client: withLineage, ...f,
  });
  assert.equal(result.dryRun, true);
  assert.deepEqual(calls, [{ installed: oldSource, candidate: source }]);
  assert.equal(f.actions.length, 0);
  await assert.rejects(
    executeUpdaterRuntime({
      environment: { ...environment(directory), FUSION_UPDATER_DRY_RUN: "1" },
      client: { ...client, sourceLineage: async () => false }, ...fixtures(directory, { docker: {
        runtimeIdentity: () => ({
          version: manifest.version, source_sha: oldSource, api_image: oldApi, ui_image: oldUi,
        }),
      } }),
    }),
    /installed_source_ancestry_unverified/,
  );
});

test("operator-only adoption verifies live release and atomically records IDLE without Docker mutation", async () => {
  const live = { version: manifest.version, source_sha: manifest.source_sha, api_image: api, ui_image: ui };
  const f = fixtures(directory, {
    docker: {
      runtimeIdentity: () => live,
      captureBaseline: async () => ({ ...baseline, maintenance: null, version: live.version, source_sha: live.source_sha }),
    },
    maintenance: { bootstrapStatus: async () => ({ bootstrapped: true, project, source_sha: oldSource }) },
  });
  const state = f.stateStore.transition(f.stateStore.load(), "FAILED", {
    failure: { code: "BOOTSTRAP_REQUIRED", stage: "bootstrap" },
  });
  const env = { ...environment(directory), FUSION_UPDATER_DRY_RUN: "1" };
  const result = await adoptVerifiedInstalledRuntime({ sourceSha: source, environment: env, client, ...f });
  assert.equal(result.adopted, true);
  assert.equal(runtimeOutcome(result).status, 0);
  const adopted = f.stateStore.load();
  assert.equal(adopted.status, "IDLE", "adoption must not manufacture deployment SUCCESS");
  assert.deepEqual(adopted.current, live);
  assert.equal(adopted.sequence, state.sequence + 1);
  assert.equal(adopted.failure, null);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.notifications, []);
  await assert.rejects(
    adoptVerifiedInstalledRuntime({ sourceSha: source, environment: env, client, ...f }),
    /adoption_state_unsafe/,
  );
});

test("adoption fails closed for unsafe state, source mismatch and active maintenance", async () => {
  const live = { version: manifest.version, source_sha: manifest.source_sha, api_image: api, ui_image: ui };
  const env = { ...environment(directory), FUSION_UPDATER_DRY_RUN: "1" };
  const liveDocker = {
    runtimeIdentity: () => live,
    captureBaseline: async () => ({ ...baseline, maintenance: null, version: live.version, source_sha: live.source_sha }),
  };
  const bootstrapped = { bootstrapStatus: async () => ({ bootstrapped: true, project, source_sha: oldSource }) };
  const f = fixtures(directory, { docker: liveDocker, maintenance: bootstrapped });
  await assert.rejects(
    adoptVerifiedInstalledRuntime({ sourceSha: source, environment: env, client, ...f }),
    /adoption_state_unsafe/,
  );
  f.stateStore.transition(f.stateStore.load(), "FAILED", {
    failure: { code: "BOOTSTRAP_REQUIRED", stage: "bootstrap" },
  });
  await assert.rejects(
    adoptVerifiedInstalledRuntime({ sourceSha: source, environment: environment(directory), client, ...f }),
    /adoption_requires_dry_run/,
  );
  await assert.rejects(
    adoptVerifiedInstalledRuntime({
      sourceSha: source, environment: env, client, ...f,
      docker: { ...f.docker, runtimeIdentity: () => ({ ...live, source_sha: oldSource }) },
    }),
    /adoption_runtime_mismatch/,
  );
  await assert.rejects(
    adoptVerifiedInstalledRuntime({
      sourceSha: source, environment: env, client, ...f,
      docker: { ...f.docker, captureBaseline: async () =>
        ({ ...baseline, maintenance: { state: "draining" }, version: live.version, source_sha: live.source_sha }) },
    }),
    /adoption_health_or_migration_mismatch/,
  );
  await assert.rejects(
    adoptVerifiedInstalledRuntime({
      sourceSha: source, environment: env, client, ...f,
      maintenance: { bootstrapStatus: async () => ({ bootstrapped: false, reason: "schema_missing" }) },
    }),
    /adoption_bootstrap_unsafe/,
  );
  await assert.rejects(
    adoptVerifiedInstalledRuntime({ sourceSha: oldSource, environment: env, client, ...f }),
    /adoption_release_untrusted/,
  );
  assert.equal(f.stateStore.load().status, "FAILED", "failed adoption must not alter durable state");
  assert.deepEqual(f.actions, []);
});

test("manual adoption reports only safe stage on unexpected release discovery/attestation failures", async () => {
  const env = { ...environment(directory), FUSION_UPDATER_DRY_RUN: "1" };
  const f = fixtures(directory);
  f.stateStore.transition(f.stateStore.load(), "FAILED", {
    failure: { code: "BOOTSTRAP_REQUIRED", stage: "bootstrap" },
  });
  const sourceSha = source;
  const privateDetail = "https://example.invalid/private?token=SECRET";
  for (const [clientOverride, safeCode] of [
    [{ ...client, runs: async () => { throw Error(`fetch failed ${privateDetail}`); } }, "adoption_release_listing_failed"],
    [{ ...client, attestation: async () => { throw Error(`unexpected verifier result ${privateDetail}`); } }, "adoption_release_attestation_failed"],
  ]) {
    await assert.rejects(
      adoptVerifiedInstalledRuntime({ sourceSha, environment: env, client: clientOverride, ...f }),
      (error) => {
        assert.equal(safeRuntimeFailureCode(error), safeCode);
        assert.doesNotMatch(error.message, /SECRET|example\\.invalid/);
        return true;
      },
    );
    assert.equal(f.stateStore.load().status, "FAILED");
    assert.deepEqual(f.actions, []);
  }
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

test("updater CLI returns exit zero only for a truly verified read-only dry-run", () => {
  const valid = runtimeOutcome({
    updated: false, dryRun: true,
    plan: { project: "fusion_runtime_test", services: ["api", "worker", "ui"], dryRun: true },
  });
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /dry-run verification PASS/);
  assert.equal(runtimeOutcome({ updated: true }).status, 0);
  assert.equal(runtimeOutcome({ updated: false, reason: "no_update" }).status, 0);
  assert.equal(runtimeOutcome({ updated: false, reason: "replay" }).status, 0);
  for (const bad of [
    { updated: false, reason: "registry_http_403" },
    { updated: false, reason: "BOOTSTRAP_REQUIRED" },
    { updated: false, reason: "recovery_required" },
    { updated: false, reason: "unsafe_migration", dryRun: true },
    { updated: false, dryRun: true },
    { updated: false, dryRun: true, plan: { dryRun: false } },
    { updated: false, dryRun: true, plan: { dryRun: true }, reason: "unsafe_project" },
    undefined,
  ]) assert.equal(runtimeOutcome(bad).status, 1, "errors and incomplete results must fail closed");
});

test("systemd receives safe error codes without secrets or exception stack traces", () => {
  assert.equal(safeRuntimeFailureCode(new Error("registry_http_403")), "registry_http_403");
  assert.equal(safeRuntimeFailureCode(new Error("artifact_http_401")), "artifact_http_401");
  assert.equal(safeRuntimeFailureCode(new Error("installed_source_ancestry_unverified")), "installed_source_ancestry_unverified");
  for (const errorCode of ["EACCES", "EPERM"]) {
    const error = Object.assign(new Error("EACCES: permission denied /private/runtime.env?token=SENSITIVE"), { code: errorCode });
    assert.equal(safeRuntimeFailureCode(error), "file_access_denied");
  }
  for (const errorCode of ["ENOENT", "ENOTDIR"]) {
    const error = Object.assign(new Error("ENOENT: /secret/private/runtime.env"), { code: errorCode });
    assert.equal(safeRuntimeFailureCode(error), "file_path_unavailable");
  }
  assert.equal(safeRuntimeFailureCode({ code: "EVIL", message: "Bearer SECRET" }), "runtime_failure");
  for (const secretBearing of [
    new Error("GET https://ghcr.io/token?secret=value"),
    new Error("Bearer ghp_SecretToken"),
    new Error("/etc/changd-fusion/updater.env: permission denied"),
    { message: "registry_http_403\nsecret" },
    { message: undefined },
  ]) assert.equal(safeRuntimeFailureCode(secretBearing), "runtime_failure");
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
  assert.equal(runtimeConfiguration(valid).uiHostPort, 3000);
  assert.equal(runtimeConfiguration({ ...valid, FUSION_UI_HOST_PORT: "8126" }).uiHostPort, 8126);
  for (const changed of [{ FUSION_UPDATER_DRY_RUN: "true" }, { FUSION_COMPOSE_ENV_FILE: "relative.env" },
    { FUSION_COMPOSE_BASE_FILE: "compose.yml" }, { FUSION_COMPOSE_OVERRIDE_FILE: "override.yml" },
    { FUSION_TRUSTED_REPOSITORY: "foreign/project" }, { FUSION_UI_HOST_PORT: "0" },
    { FUSION_UI_HOST_PORT: "65536" }, { FUSION_UI_HOST_PORT: "3000/path" }]) {
    assert.throws(() => runtimeConfiguration({ ...valid, ...changed }), /invalid_updater_configuration|invalid_ui_host_port/);
  }
});


test("Docker CLI config accepts empty config and staged GHCR-only auth without exposing it", async () => {
  const folder = path.join(directory, "docker-config");
  await mkdir(folder, { mode: 0o700 });
  await chmod(folder, 0o700);
  assert.equal(validateDockerCliConfiguration({ DOCKER_CONFIG: folder }), undefined);
  const file = path.join(folder, "config.json");
  await writeFile(file, JSON.stringify({ auths: { "ghcr.io": { auth: "synthetic-test-token" } } }), { mode: 0o400 });
  await chmod(file, 0o400);
  assert.equal(validateDockerCliConfiguration({ DOCKER_CONFIG: folder }), undefined);
});

test("Docker CLI config rejects helpers, external registry credentials and dangerous keys", async () => {
  const folder = path.join(directory, "docker-config");
  await mkdir(folder, { mode: 0o700 });
  await chmod(folder, 0o700);
  const file = path.join(folder, "config.json");
  for (const [config, expected] of [
    [{ auths: {}, credsStore: "pass" }, "unsupported_docker_credential_helper"],
    [{ credHelpers: { "ghcr.io": "secretservice" } }, "unsupported_docker_credential_helper"],
    [{ auths: { "registry.example.invalid": { auth: "synthetic-secret" } } }, "unsupported_docker_configuration"],
    [{ currentContext: "remote" }, "unsupported_docker_configuration"],
    [{ HttpHeaders: { Authorization: "synthetic-secret" } }, "unsupported_docker_configuration"],
    [{ auths: { "ghcr.io": { "auth": 123 } } }, "unsupported_docker_configuration"],
    [[], "invalid_docker_config"],
  ]) {
    await rm(file, { force: true });
    await writeFile(file, JSON.stringify(config), { mode: 0o400 });
    await chmod(file, 0o400);
    assert.throws(() => validateDockerCliConfiguration({ DOCKER_CONFIG: folder }), {
      message: expected,
    });
  }
});

test("Docker CLI config refuses symlinks and overly permissive credential files", async () => {
  const folder = path.join(directory, "docker-config");
  await mkdir(folder, { mode: 0o700 });
  await chmod(folder, 0o700);
  const file = path.join(folder, "config.json");
  const target = path.join(directory, "source-secret");
  await writeFile(target, '{"auths":{}}');
  await symlink(target, file);
  assert.throws(() => validateDockerCliConfiguration({ DOCKER_CONFIG: folder }), /invalid_docker_config/);
  await rm(file);
  await writeFile(file, '{"auths":{}}', { mode: 0o600 });
  await chmod(file, 0o600);
  assert.throws(() => validateDockerCliConfiguration({ DOCKER_CONFIG: folder }), /invalid_docker_config/);
  await rm(file);
  await writeFile(file, "x".repeat(131073), { mode: 0o400 });
  await chmod(file, 0o400);
  assert.throws(() => validateDockerCliConfiguration({ DOCKER_CONFIG: folder }), /invalid_docker_config/);
});
