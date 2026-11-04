import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDockerComposeHostAdapter,
} from "./docker-compose-adapter.mjs";
import { runUpdater } from "./ghcr-updater.mjs";
import { ComposeMaintenanceCoordinator } from "./maintenance-coordinator.mjs";

const project = "fusion_adapter_test";
const source = "a".repeat(40);
const apiDigest = "b".repeat(64);
const uiDigest = "c".repeat(64);
const release = {
  version: "0.3.3",
  source_sha: source,
  api_image: `ghcr.io/mkaand/changd-fusion-api@sha256:${apiDigest}`,
  ui_image: `ghcr.io/mkaand/changd-fusion-ui@sha256:${uiDigest}`,
  api_worker_shared_image: `ghcr.io/mkaand/changd-fusion-api@sha256:${apiDigest}`,
};
const migrationEvidence = Array.from({ length: 18 }, (_, index) => ({
  name: `${String(index + 1).padStart(3, "0")}_fixture.sql`, sha256: String(index % 10).repeat(64),
}));
const healthSnapshot = (maintenance = null) => ({ schema: 1, version: "0.3.3", source_sha: source,
  monitor_count: 4, enabled_count: 2, paused_count: 1, baseline_count: 3, event_count: 8, capture_count: 7,
  monitor_signature: "9".repeat(64), migrations: migrationEvidence, maintenance });
const dbImage = "postgres:16.15-alpine@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36";
let directory;
let baseFile;
let overrideFile;
let envFile;

test.before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "fusion-adapter-unit-"));
  baseFile = path.join(directory, "docker-compose.yml");
  overrideFile = path.join(directory, "docker-compose.ghcr.yml");
  envFile = path.join(directory, "adapter.env");
  await writeFile(baseFile, "services: {}\n");
  await writeFile(overrideFile, "services: {}\n");
  await writeFile(envFile, "FIXTURE=true\n");
});
test.after(() => rm(directory, { recursive: true, force: true }));

const network = () => ({ fusion: null });
const volume = (sourceName, target) => [{ type: "volume", source: sourceName, target, volume: {} }];
const app = (image) => ({
  image,
  environment: { CHROMIUM_CONCURRENCY: "1" },
  volumes: volume("captures", "/data"),
  networks: network(),
});

function composeModel() {
  return {
    name: project,
    volumes: {
      captures: { name: `${project}_captures` },
      database: { name: `${project}_database` },
    },
    networks: { fusion: { name: `${project}_fusion`, ipam: {} } },
    services: {
      api: {
        ...app(release.api_image),
        cpus: 0.75,
        mem_limit: "671088640",
        pids_limit: 192,
        shm_size: "67108864",
        security_opt: ["seccomp=./docker/chromium-seccomp.json"],
      },
      db: {
        image: dbImage,
        volumes: volume("database", "/var/lib/postgresql/data"),
        networks: network(),
      },
      migrate: app(release.api_image),
      ui: {
        image: release.ui_image,
        networks: network(),
        ports: [{ host_ip: "127.0.0.1", target: 8080, published: "3000" }],
      },
      worker: {
        ...app(release.api_image),
        cpus: 1,
        mem_limit: "1073741824",
        pids_limit: 256,
        shm_size: "268435456",
        security_opt: ["seccomp=./docker/chromium-seccomp.json"],
      },
    },
  };
}

const id = (character) => character.repeat(64);

function container(service, character) {
  const images = { api: release.api_image, worker: release.api_image, ui: release.ui_image, db: dbImage };
  const application = ["api", "worker"].includes(service);
  const limits = service === "api"
    ? { NanoCpus: 750_000_000, Memory: 671_088_640, PidsLimit: 192, ShmSize: 67_108_864 }
    : { NanoCpus: 1_000_000_000, Memory: 1_073_741_824, PidsLimit: 256, ShmSize: 268_435_456 };
  return {
    Id: id(character),
    Config: {
      Image: images[service],
      User: application ? "10001:10001" : "1000:1000",
      Env: application ? ["CHROMIUM_CONCURRENCY=1"] : [],
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
        "com.docker.compose.project.working_dir": directory,
        "com.docker.compose.project.config_files": `${baseFile},${overrideFile}`,
      },
    },
    State: {
      Running: true,
      ...(["api", "worker", "db"].includes(service) ? { Health: { Status: "healthy" } } : {}),
    },
    HostConfig: application ? {
      ...limits,
      Privileged: false,
      CapAdd: null,
      SecurityOpt: ["seccomp=fixture"],
    } : {},
    Mounts: service === "db"
      ? [{ Type: "volume", Name: `${project}_database`, Destination: "/var/lib/postgresql/data" }]
      : application
        ? [{ Type: "volume", Name: `${project}_captures`, Destination: "/data" }]
        : [],
    NetworkSettings: { Networks: { [`${project}_fusion`]: {} } },
  };
}

function defaultContainers() {
  return [container("api", "1"), container("db", "2"), container("ui", "3"), container("worker", "4")];
}

function fakeSpawn({ model = composeModel(), containers = defaultContainers(), fail = false, failUpdate = false, maintenance, health } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (fail) return { status: null, stdout: "", error: new Error("fixture timeout") };
    if (args.includes("config")) return { status: 0, stdout: JSON.stringify(model) };
    if (args[1] === "ps") {
      return { status: 0, stdout: containers.map((value) => JSON.stringify({ ID: value.Id })).join("\n") };
    }
    if (args[1] === "inspect") return { status: 0, stdout: JSON.stringify(containers) };
    if (args[1] === "image") {
      const reference = args.at(-1);
      return { status: 0, stdout: JSON.stringify([{
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [reference],
      }]) };
    }
    if (args.includes("dist/maintenance-cli.js")) {
      const action = args.at(-1);
      if (maintenance) return { status: 0, stdout: JSON.stringify(maintenance(action, JSON.parse(options.input))) };
      return { status: 0, stdout: JSON.stringify(action === "verify" ? { valid: true } : { resumed: true }) };
    }
    if (args.includes("dist/deployment-health-cli.js")) {
      return { status: 0, stdout: JSON.stringify(typeof health === "function" ? health() : health ?? healthSnapshot()) };
    }
    if (failUpdate && args.includes("up")) return { status: 1, stdout: "" };
    if (args.includes("pull") || args.includes("up")) return { status: 0, stdout: "" };
    return { status: 1, stdout: "" };
  };
  return { spawn, calls };
}

function adapter(fake, overrides = {}) {
  return createDockerComposeHostAdapter({
    project,
    projectDirectory: directory,
    composeFiles: [baseFile, overrideFile],
    envFile,
    spawn: fake.spawn,
    processEnvironment: { FIXTURE: "true", DOCKER_HOST: "tcp://foreign.invalid:2375", FUSION_GITHUB_TOKEN: "must-not-leak" },
    now: () => 100_000,
    drainVerifier: async (evidence, context) => evidence.proof === "verified" && ["authorize", "assert"].includes(context.phase),
    ...overrides,
  });
}

const authorization = () => ({
  id: "11111111-1111-4111-8111-111111111111",
  operation_id: "11111111-1111-4111-8111-111111111111",
  project,
  source_sha: source,
  issued_at: 90_000,
  expires_at: 200_000,
  owner_token: "d".repeat(43),
  proof: "verified",
});

test("validates the effective Compose project, ownership and current runtime", async () => {
  const fake = fakeSpawn();
  const host = adapter(fake);
  assert.equal(await host.projectIsExpected(project, ["api", "worker", "ui"], release), true);
  assert.equal(host.lastFailure, null);
  assert.ok(fake.calls.some((call) => call.args.includes("config")));
  const listing = fake.calls.find((call) => call.args[1] === "ps");
  assert.ok(listing.args.includes(`label=com.docker.compose.project=${project}`));
  assert.equal(listing.options.env.DOCKER_HOST, undefined);
  assert.equal(listing.options.env.FUSION_GITHUB_TOKEN, undefined);
  assert.equal(listing.options.shell, false);
});

test("rejects missing, duplicate and foreign project service containers", async () => {
  const variants = [
    defaultContainers().filter((value) => value.Config.Labels["com.docker.compose.service"] !== "worker"),
    [...defaultContainers(), container("api", "5")],
    defaultContainers().map((value, index) => index === 0
      ? { ...value, Config: { ...value.Config, Labels: { ...value.Config.Labels, "com.docker.compose.service": "other" } } }
      : value),
  ];
  for (const containers of variants) {
    const host = adapter(fakeSpawn({ containers }));
    assert.equal(await host.projectIsExpected(project, ["api", "worker", "ui"], release), false);
    assert.match(host.lastFailure, /missing_or_duplicate_container|foreign_project_container/);
  }
});

test("rejects resource, volume, network, build and image configuration drift", async () => {
  const variants = [];
  const resources = structuredClone(composeModel());
  resources.services.worker.pids_limit = 999;
  variants.push(resources);
  const volumes = structuredClone(composeModel());
  volumes.services.db.volumes = [];
  variants.push(volumes);
  const networks = structuredClone(composeModel());
  networks.services.ui.networks = { foreign: null };
  variants.push(networks);
  const builds = structuredClone(composeModel());
  builds.services.api.build = { context: "." };
  variants.push(builds);
  const images = structuredClone(composeModel());
  images.services.worker.image = "changd-fusion-api:latest";
  variants.push(images);
  for (const model of variants) {
    const host = adapter(fakeSpawn({ model }));
    assert.equal(await host.projectIsExpected(project, ["api", "worker", "ui"], release), false);
  }
});

test("requires fresh verified drain evidence before exact pull and no-build update", async () => {
  const fake = fakeSpawn();
  const host = adapter(fake);
  assert.equal(await host.projectIsExpected(project, ["api", "worker", "ui"], release), true);
  await assert.rejects(
    host.compose(project, ["pull", "api", "worker", "ui"], source, release),
    /safe_drain_required/,
  );
  const evidence = authorization();
  assert.equal(await host.safeDrain(project, source, evidence), true);
  assert.equal(await host.safeDrain(project, source, evidence), false);
  await host.compose(project, ["pull", "api", "worker", "ui"], source, release);
  await host.compose(project, ["up", "-d", "--no-deps", "--no-build", "api", "worker", "ui"], source, release);
  const mutations = fake.calls.filter((call) => call.args.includes("pull") || call.args.includes("up"));
  assert.equal(mutations.length, 2);
  assert.equal(mutations.some((call) => call.args.includes("db") || call.args.includes("migrate")), false);
  assert.equal(fake.calls.filter((call) => call.args[1] === "image").length, 2);
  assert.equal(await host.healthy({ project, images: { api: release.api_image, ui: release.ui_image } }), true);
  host.completeDrain();
  await assert.rejects(
    host.compose(project, ["pull", "api", "worker", "ui"], source, release),
    /safe_drain_required/,
  );
});

test("captures a read-only baseline and verifies images, data continuity and barrier-closed health", async () => {
  let deploying = false;
  const fake = fakeSpawn({ health: () => healthSnapshot(deploying ? { state: "deploying", project } : null) });
  const host = adapter(fake, { fetchImpl: async (url) => url.endsWith("/api/v1/health")
    ? new Response(JSON.stringify({ status: "ok", version: "0.3.3", source_sha: source, maintenance: true }), { status: 200 })
    : new Response("ui", { status: 200 }) });
  await host.validateProject(release);
  const baseline = await host.captureBaseline();
  assert.equal(baseline.paused_count, 1);
  assert.equal(await host.safeDrain(project, source, authorization()), true);
  deploying = true;
  assert.equal(await host.verifyDeploymentHealth({ project, images: { api: release.api_image, ui: release.ui_image } }, baseline), true);
  const changed = { ...baseline, monitor_count: baseline.monitor_count + 1 };
  assert.equal(await host.verifyDeploymentHealth({ project, images: { api: release.api_image, ui: release.ui_image } }, changed), false);
});

test("maintenance evidence is reverified across mutation and never exposed in subprocess arguments", async () => {
  const phases = [];
  const fake = fakeSpawn();
  const host = adapter(fake, {
    drainVerifier: async (_evidence, context) => { phases.push(context.phase); return true; },
  });
  await host.validateProject(release);
  const evidence = authorization();
  assert.equal(await host.safeDrain(project, source, evidence), true);
  await host.compose(project, ["pull", "api", "worker", "ui"], source, release);
  await host.compose(project, ["up", "-d", "--no-deps", "--no-build", "api", "worker", "ui"], source, release);
  assert.equal(await host.healthy({ project, images: { api: release.api_image, ui: release.ui_image } }), true);
  assert.deepEqual(phases, ["authorize", "assert", "assert", "assert"]);
  host.maintenanceExec("verify", { evidence, phase: "assert" });
  const invocation = fake.calls.at(-1);
  assert.equal(invocation.args.join(" ").includes(evidence.owner_token), false);
  assert.equal(invocation.options.input.includes(evidence.owner_token), true);
});

test("lost maintenance ownership blocks the next Compose mutation", async () => {
  let valid = true;
  const fake = fakeSpawn();
  const host = adapter(fake, { drainVerifier: async (_evidence, context) => context.phase === "authorize" || valid });
  await host.validateProject(release);
  assert.equal(await host.safeDrain(project, source, authorization()), true);
  valid = false;
  await assert.rejects(host.compose(project, ["pull", "api", "worker", "ui"], source, release), /safe_drain_lost/);
  assert.equal(fake.calls.some((call) => call.args.includes("pull")), false);
});

test("connects to runUpdater while retaining the concrete drain boundary", async () => {
  const candidate = {
    ...release,
    version: "0.3.3",
    architecture: "linux/amd64",
    migrationCompatibility: "forward-safe",
    migrationVersion: 1,
  };
  const evidence = {
    manifest: candidate,
    workflow: { name: "GHCR immutable release", conclusion: "success", head_sha: source },
    masterLineage: true,
    ci: { verify: "success", privacy: "success", docker: "success", "docker-arm64": "success" },
    publisher: { attested: true, revision: source, version: "0.3.3" },
  };
  const blockedFake = fakeSpawn();
  const blockedHost = adapter(blockedFake);
  blockedHost.writeStateAtomically = async () => assert.fail("state must not change without drain");
  const blocked = await runUpdater({
    evidence,
    state: { migrationVersion: 1 },
    config: { project },
    docker: blockedHost,
  });
  assert.equal(blocked.reason, "unsafe_drain");
  assert.equal(blockedFake.calls.some((call) => call.args.includes("pull") || call.args.includes("up")), false);

  const fake = fakeSpawn();
  const host = adapter(fake);
  let state;
  host.writeStateAtomically = async (next) => { state = next; };
  const result = await runUpdater({
    evidence,
    state: { migrationVersion: 1 },
    config: { project },
    docker: host,
    drainAuthorization: authorization(),
  });
  assert.equal(result.updated, true);
  assert.equal(state.source_sha, source);
  assert.equal(fake.calls.filter((call) => call.args.includes("pull") || call.args.includes("up")).length, 2);
});

test("runUpdater acquires, continuously verifies and resumes the concrete maintenance barrier", async () => {
  const candidate = {
    ...release, version: "0.3.3", architecture: "linux/amd64",
    migrationCompatibility: "forward-safe", migrationVersion: 1,
  };
  const evidence = {
    manifest: candidate,
    workflow: { name: "GHCR immutable release", conclusion: "success", head_sha: source },
    masterLineage: true,
    ci: { verify: "success", privacy: "success", docker: "success", "docker-arm64": "success" },
    publisher: { attested: true, revision: source, version: "0.3.3" },
  };
  const actions = [];
  const authorization = {
    id: "22222222-2222-4222-8222-222222222222",
    operation_id: "22222222-2222-4222-8222-222222222222",
    project, source_sha: source, issued_at: 90_000, expires_at: 200_000,
    owner_token: "e".repeat(43),
  };
  const fake = fakeSpawn({ maintenance(action) {
    actions.push(action);
    if (action === "begin") return authorization;
    if (action === "verify") return { valid: true };
    if (action === "resume") return { resumed: true };
    return { retained: true };
  } });
  const host = adapter(fake, { drainVerifier: undefined });
  const maintenance = new ComposeMaintenanceCoordinator({ adapter: host, timeoutMs: 1000, evidenceTtlMs: 5000 });
  host.writeStateAtomically = async () => {};
  const result = await runUpdater({
    evidence, state: { migrationVersion: 1 }, config: { project }, docker: host, maintenance,
  });
  assert.equal(result.updated, true);
  assert.deepEqual(actions, ["begin", "verify", "verify", "verify", "verify", "resume"]);
});

test("an interrupted Compose replacement records recovery-required maintenance and never resumes", async () => {
  const candidate = {
    ...release, version: "0.3.3", architecture: "linux/amd64",
    migrationCompatibility: "forward-safe", migrationVersion: 1,
  };
  const evidence = {
    manifest: candidate,
    workflow: { name: "GHCR immutable release", conclusion: "success", head_sha: source },
    masterLineage: true,
    ci: { verify: "success", privacy: "success", docker: "success", "docker-arm64": "success" },
    publisher: { attested: true, revision: source, version: "0.3.3" },
  };
  const actions = [];
  const authorization = {
    id: "33333333-3333-4333-8333-333333333333",
    operation_id: "33333333-3333-4333-8333-333333333333",
    project, source_sha: source, issued_at: 90_000, expires_at: 200_000,
    owner_token: "f".repeat(43),
  };
  const fake = fakeSpawn({ failUpdate: true, maintenance(action) {
    actions.push(action);
    if (action === "begin") return authorization;
    if (action === "verify") return { valid: true };
    if (action === "fail") return { retained: true };
    return { resumed: true };
  } });
  const host = adapter(fake, { drainVerifier: undefined });
  const maintenance = new ComposeMaintenanceCoordinator({ adapter: host, timeoutMs: 1000, evidenceTtlMs: 5000 });
  host.writeStateAtomically = async () => assert.fail("failed deployment must not update state");
  const result = await runUpdater({
    evidence, state: { migrationVersion: 1 }, config: { project }, docker: host, maintenance,
  });
  assert.equal(result.reason, "deployment_failed");
  assert.equal(actions.at(-1), "fail");
  assert.equal(actions.includes("resume"), false);
});

test("dry-run executes read-only validation but performs zero Docker mutations", async () => {
  const fake = fakeSpawn();
  const host = adapter(fake, { dryRun: true });
  assert.equal(await host.projectIsExpected(project, ["api", "worker", "ui"], release), true);
  assert.equal(await host.safeDrain(project, source, authorization()), true);
  await host.compose(project, ["pull", "api", "worker", "ui"], source, release);
  await host.compose(project, ["up", "-d", "--no-deps", "--no-build", "api", "worker", "ui"], source, release);
  assert.equal(fake.calls.some((call) => call.args.includes("pull") || call.args.includes("up")), false);
  assert.equal(fake.calls.some((call) => call.args[1] === "image"), false);
});

test("rejects mutable images, out-of-scope commands, injection and subprocess failures", async () => {
  const mutable = { ...release, api_image: "ghcr.io/mkaand/changd-fusion-api:latest" };
  const initial = fakeSpawn();
  assert.equal(await adapter(initial).projectIsExpected(project, ["api", "worker", "ui"], mutable), false);
  assert.equal(initial.calls.length, 0);
  assert.throws(() => adapter(fakeSpawn(), { project: "fusion;docker system prune" }), /invalid_project/);
  assert.throws(() => adapter(fakeSpawn(), { socket: "tcp://foreign.invalid:2375" }), /invalid_docker_socket/);
  assert.throws(() => adapter(fakeSpawn(), { socket: "unix:///var/run/../foreign.sock" }), /invalid_docker_socket/);
  const failed = adapter(fakeSpawn({ fail: true }));
  assert.throws(() => failed.validateEffectiveConfig(release), /docker_command_failed/);
  const fake = fakeSpawn();
  const host = adapter(fake);
  await host.validateProject(release);
  assert.equal(await host.safeDrain(project, source, authorization()), true);
  await assert.rejects(
    host.compose("another_project", ["pull", "api", "worker", "ui"], source, release),
    /project_scope_violation/,
  );
  await assert.rejects(
    host.compose(project, ["down", "--volumes"], source, release),
    /compose_operation_forbidden/,
  );
  assert.equal(fake.calls.some((call) => call.args.includes("down")), false);
});

test("fails closed without a drain verifier or with stale authorization", async () => {
  const fake = fakeSpawn();
  const noVerifier = adapter(fake, { drainVerifier: undefined });
  await noVerifier.validateProject(release);
  assert.equal(await noVerifier.safeDrain(project, source, authorization()), false);
  const host = adapter(fake);
  await host.validateProject(release);
  assert.equal(await host.safeDrain(project, source, { ...authorization(), expires_at: 100_000 }), false);
});

test("rejects Compose or environment changes after project validation", async () => {
  const host = adapter(fakeSpawn());
  await host.validateProject(release);
  assert.equal(await host.safeDrain(project, source, authorization()), true);
  await writeFile(overrideFile, "services: {}\n# changed after validation\n");
  try {
    await assert.rejects(
      host.compose(project, ["pull", "api", "worker", "ui"], source, release),
      /safe_drain_required/,
    );
  } finally {
    await writeFile(overrideFile, "services: {}\n");
  }
});
