import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA = /^[0-9a-f]{40}$/;
const DRAIN_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const API_IMAGE = /^ghcr\.io\/mkaand\/changd-fusion-api@sha256:[0-9a-f]{64}$/;
const UI_IMAGE = /^ghcr\.io\/mkaand\/changd-fusion-ui@sha256:[0-9a-f]{64}$/;
const UNIX_SOCKET = /^unix:\/\/\/[^\0\r\n]+$/;
const EXPECTED_SERVICES = ["api", "db", "migrate", "ui", "worker"];
const RUNTIME_SERVICES = ["api", "db", "ui", "worker"];
const UPDATE_SERVICES = ["api", "worker", "ui"];
const DB_IMAGE = "postgres:16.15-alpine@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36";
const MAX_OUTPUT = 2_000_000;

export class DockerAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = "DockerAdapterError";
    this.code = code;
  }
}

function fail(code) {
  throw new DockerAdapterError(code);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object") return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function serviceEnvironment(service) {
  if (Array.isArray(service?.environment)) {
    return Object.fromEntries(service.environment.map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 0 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  return service?.environment ?? {};
}

function assertServiceNetwork(service) {
  if (!exactKeys(service?.networks, ["fusion"])) fail("compose_network_contract");
}

function assertVolume(service, source, target) {
  const matches = (service?.volumes ?? []).filter(
    (volume) => volume?.type === "volume" && volume?.source === source && volume?.target === target,
  );
  if (matches.length !== 1) fail("compose_volume_contract");
}

function assertModelLimits(service, expected) {
  if (Number(service?.cpus) !== expected.cpus
    || Number(service?.mem_limit) !== expected.memory
    || Number(service?.pids_limit) !== expected.pids
    || Number(service?.shm_size) !== expected.shm) {
    fail("compose_resource_contract");
  }
  if (!Array.isArray(service.security_opt)
    || !service.security_opt.includes("seccomp=./docker/chromium-seccomp.json")
    || service.security_opt.some((value) => value.includes("unconfined"))) {
    fail("compose_sandbox_contract");
  }
  if (String(serviceEnvironment(service).CHROMIUM_CONCURRENCY) !== "1") {
    fail("compose_chromium_concurrency");
  }
}

function assertRelease(release) {
  if (!release || !SHA.test(release.source_sha ?? "")
    || !API_IMAGE.test(release.api_image ?? "")
    || !UI_IMAGE.test(release.ui_image ?? "")
    || release.api_worker_shared_image !== release.api_image) {
    fail("invalid_release_images");
  }
}

function releaseKey(release) {
  return `${release.source_sha}:${release.api_image}:${release.ui_image}`;
}

function safeFile(projectDirectory, candidate) {
  const resolved = realpathSync(candidate);
  const relative = path.relative(projectDirectory, resolved);
  if (!statSync(resolved).isFile() || relative.startsWith("..") || path.isAbsolute(relative)
    || relative === "") {
    fail("invalid_compose_file");
  }
  return resolved;
}

function absoluteFile(candidate) {
  if (!path.isAbsolute(candidate ?? "")) fail("invalid_compose_file");
  const resolved = realpathSync(candidate);
  if (!statSync(resolved).isFile()) fail("invalid_compose_file");
  return resolved;
}

function samePathSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function parseJson(value, code) {
  try {
    return JSON.parse(value);
  } catch {
    fail(code);
  }
}

export class DockerComposeHostAdapter {
  constructor({
    project,
    projectDirectory,
    composeFiles,
    ownershipComposeFiles,
    envFile,
    dockerBinary = "docker",
    socket = "unix:///var/run/docker.sock",
    timeoutMs = 120_000,
    dryRun = false,
    spawn = spawnSync,
    processEnvironment = process.env,
    drainVerifier,
    fetchImpl = fetch,
    uiBaseUrl = "http://127.0.0.1:3000",
    now = Date.now,
  } = {}) {
    if (!PROJECT.test(project ?? "")) fail("invalid_project");
    const directory = realpathSync(projectDirectory);
    if (!statSync(directory).isDirectory()) fail("invalid_project_directory");
    if (!Array.isArray(composeFiles) || composeFiles.length !== 2) fail("invalid_compose_files");
    this.project = project;
    this.projectDirectory = directory;
    this.composeFiles = [safeFile(directory, composeFiles[0]), absoluteFile(composeFiles[1])];
    this.ownershipComposeFiles = (ownershipComposeFiles ?? [composeFiles[0]]).map((file) => safeFile(directory, file));
    if (!this.ownershipComposeFiles.length || this.ownershipComposeFiles.length > this.composeFiles.length
      || this.ownershipComposeFiles.some((file) => !this.composeFiles.includes(file))) fail("invalid_ownership_files");
    this.envFile = envFile ? safeFile(directory, envFile) : undefined;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) fail("invalid_timeout");
    const socketPath = typeof socket === "string" ? socket.slice("unix://".length) : "";
    if (!UNIX_SOCKET.test(socket ?? "") || !path.isAbsolute(socketPath)
      || socketPath.split(path.sep).includes("..")) fail("invalid_docker_socket");
    this.dockerBinary = dockerBinary;
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.dryRun = Boolean(dryRun);
    this.spawn = spawn;
    this.processEnvironment = processEnvironment;
    this.drainVerifier = drainVerifier;
    this.now = now;
    if (uiBaseUrl !== "http://127.0.0.1:3000") fail("invalid_health_endpoint");
    this.fetchImpl = fetchImpl;
    this.uiBaseUrl = uiBaseUrl;
    this.usedDrainEvidence = new Set();
    this.drainGrant = null;
    this.validatedRelease = null;
    this.validatedConfiguration = null;
    this.databaseContainerId = null;
    this.lastFailure = null;
  }

  childEnvironment(extra = {}) {
    const environment = { ...this.processEnvironment, ...extra };
    for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
      delete environment[name];
    }
    for (const name of ["FUSION_GITHUB_TOKEN", "FUSION_TELEGRAM_BOT_TOKEN", "FUSION_TELEGRAM_CHAT_ID", "GH_TOKEN", "GITHUB_TOKEN"]) {
      delete environment[name];
    }
    return environment;
  }

  setDrainVerifier(verifier) {
    if (typeof verifier !== "function" || this.drainVerifier || this.validatedRelease) {
      fail("drain_verifier_configuration");
    }
    this.drainVerifier = verifier;
  }

  runDocker(args, { mutating = false, environment = {}, input } = {}) {
    if (!Array.isArray(args) || args.some((value) => typeof value !== "string" || /[\0\r\n]/.test(value))) {
      fail("invalid_docker_arguments");
    }
    const command = [`--host=${this.socket}`, ...args];
    if (mutating && this.dryRun) return { dryRun: true, command: [this.dockerBinary, ...command] };
    const result = this.spawn(this.dockerBinary, command, {
      cwd: this.projectDirectory,
      env: this.childEnvironment(environment),
      encoding: "utf8",
      timeout: this.timeoutMs,
      maxBuffer: MAX_OUTPUT,
      shell: false,
      ...(input === undefined ? {} : { input }),
    });
    if (result?.error || result?.status !== 0 || result?.signal) fail("docker_command_failed");
    if (typeof result.stdout !== "string" || Buffer.byteLength(result.stdout) > MAX_OUTPUT) {
      fail("docker_output_invalid");
    }
    return { stdout: result.stdout, command: [this.dockerBinary, ...command] };
  }

  composeArguments(command) {
    const args = [
      "compose",
      "--project-directory", this.projectDirectory,
      "--project-name", this.project,
    ];
    for (const file of this.composeFiles) args.push("--file", file);
    if (this.envFile) args.push("--env-file", this.envFile);
    return [...args, ...command];
  }

  composeEnvironment(release) {
    return {
      FUSION_API_IMAGE: release.api_image,
      FUSION_UI_IMAGE: release.ui_image,
    };
  }

  configurationFingerprint() {
    const hash = createHash("sha256");
    for (const file of [...this.composeFiles, ...(this.envFile ? [this.envFile] : [])]) {
      hash.update(file).update("\0").update(readFileSync(file)).update("\0");
    }
    return hash.digest("hex");
  }

  validateEffectiveConfig(release) {
    assertRelease(release);
    const result = this.runDocker(this.composeArguments(["config", "--format", "json"]), {
      environment: this.composeEnvironment(release),
    });
    const model = parseJson(result.stdout, "invalid_compose_config");
    if (model.name !== this.project || !exactKeys(model.services, EXPECTED_SERVICES)
      || !exactKeys(model.volumes, ["captures", "database"])
      || !exactKeys(model.networks, ["fusion"])) {
      fail("compose_project_contract");
    }
    if (model.volumes.captures?.name !== `${this.project}_captures`
      || model.volumes.database?.name !== `${this.project}_database`
      || model.networks.fusion?.name !== `${this.project}_fusion`) {
      fail("compose_resource_identity");
    }
    const { api, db, migrate, ui, worker } = model.services;
    if (api.image !== release.api_image || worker.image !== release.api_image
      || migrate.image !== release.api_image || ui.image !== release.ui_image
      || db.image !== DB_IMAGE) {
      fail("compose_image_contract");
    }
    for (const service of [api, worker, migrate, ui]) {
      if (service.build !== undefined && service.build !== null) fail("compose_build_forbidden");
    }
    for (const service of Object.values(model.services)) assertServiceNetwork(service);
    assertVolume(db, "database", "/var/lib/postgresql/data");
    for (const service of [api, worker, migrate]) assertVolume(service, "captures", "/data");
    assertModelLimits(api, { cpus: 0.75, memory: 671_088_640, pids: 192, shm: 67_108_864 });
    assertModelLimits(worker, { cpus: 1, memory: 1_073_741_824, pids: 256, shm: 268_435_456 });
    if (String(serviceEnvironment(migrate).CHROMIUM_CONCURRENCY) !== "1") {
      fail("compose_chromium_concurrency");
    }
    const ports = ui.ports ?? [];
    if (ports.length !== 1 || ports[0].host_ip !== "127.0.0.1"
      || Number(ports[0].target) !== 8080 || String(ports[0].published) !== "3000") {
      fail("compose_ui_port_contract");
    }
    return model;
  }

  inspectProjectContainers() {
    const listing = this.runDocker([
      "ps", "--all", "--no-trunc",
      "--filter", `label=com.docker.compose.project=${this.project}`,
      "--format", "{{json .}}",
    ]).stdout.trim();
    const summaries = listing ? listing.split("\n").map((line) => parseJson(line, "invalid_container_listing")) : [];
    const ids = summaries.map((summary) => summary.ID);
    if (!ids.length || ids.some((id) => !CONTAINER_ID.test(id)) || new Set(ids).size !== ids.length) {
      fail("invalid_container_identity");
    }
    const containers = parseJson(
      this.runDocker(["inspect", ...ids]).stdout,
      "invalid_container_inspection",
    );
    if (!Array.isArray(containers) || containers.length !== ids.length) fail("ambiguous_container_inspection");
    const byService = new Map();
    for (const container of containers) {
      const labels = container?.Config?.Labels ?? {};
      const service = labels["com.docker.compose.service"];
      if (labels["com.docker.compose.project"] !== this.project || !EXPECTED_SERVICES.includes(service)) {
        fail("foreign_project_container");
      }
      if (realpathSync(labels["com.docker.compose.project.working_dir"] ?? "") !== this.projectDirectory) {
        fail("foreign_project_directory");
      }
      const configFiles = String(labels["com.docker.compose.project.config_files"] ?? "")
        .split(",").filter(Boolean).map((file) => realpathSync(file)).sort();
      if (!samePathSet(configFiles, this.ownershipComposeFiles)
        && !samePathSet(configFiles, this.composeFiles)) {
        fail("foreign_compose_configuration");
      }
      const entries = byService.get(service) ?? [];
      entries.push(container);
      byService.set(service, entries);
    }
    for (const service of RUNTIME_SERVICES) {
      if ((byService.get(service) ?? []).length !== 1) fail("missing_or_duplicate_container");
    }
    if ((byService.get("migrate") ?? []).length > 1) fail("missing_or_duplicate_container");
    for (const [service, entries] of byService) {
      if (!RUNTIME_SERVICES.includes(service) && service !== "migrate") fail("foreign_project_container");
      for (const container of entries) this.validateRuntimeContainer(service, container);
    }
    return Object.fromEntries([...byService].map(([service, entries]) => [service, entries[0]]));
  }

  validateRuntimeContainer(service, container) {
    if (RUNTIME_SERVICES.includes(service) && container?.State?.Running !== true) {
      fail("container_not_running");
    }
    if (["api", "worker", "db"].includes(service)
      && container?.State?.Health?.Status !== "healthy") {
      fail("container_not_healthy");
    }
    if (!container?.NetworkSettings?.Networks?.[`${this.project}_fusion`]) {
      fail("container_network_contract");
    }
    const expectedMount = service === "db"
      ? [`${this.project}_database`, "/var/lib/postgresql/data"]
      : ["api", "worker", "migrate"].includes(service)
        ? [`${this.project}_captures`, "/data"]
        : null;
    if (expectedMount && !(container.Mounts ?? []).some(
      (mount) => mount.Type === "volume" && mount.Name === expectedMount[0] && mount.Destination === expectedMount[1],
    )) fail("container_volume_contract");
    if (["api", "worker"].includes(service)) {
      const expected = service === "api"
        ? { nanoCpus: 750_000_000, memory: 671_088_640, pids: 192, shm: 67_108_864 }
        : { nanoCpus: 1_000_000_000, memory: 1_073_741_824, pids: 256, shm: 268_435_456 };
      const host = container.HostConfig ?? {};
      if (Number(host.NanoCpus) !== expected.nanoCpus || Number(host.Memory) !== expected.memory
        || Number(host.PidsLimit) !== expected.pids || Number(host.ShmSize) !== expected.shm
        || host.Privileged === true || (host.CapAdd ?? []).length
        || (host.SecurityOpt ?? []).some((value) => value.includes("unconfined"))
        || !(host.SecurityOpt ?? []).some((value) => value.startsWith("seccomp="))) {
        fail("container_resource_contract");
      }
      const environment = Object.fromEntries((container.Config?.Env ?? []).map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }));
      if (environment.CHROMIUM_CONCURRENCY !== "1"
        || ["", "0", "root"].includes(String(container.Config?.User ?? ""))) {
        fail("container_security_contract");
      }
    }
  }

  async validateProject(release, services = UPDATE_SERVICES) {
    assertRelease(release);
    if (JSON.stringify(services) !== JSON.stringify(UPDATE_SERVICES)) fail("invalid_update_services");
    const before = this.configurationFingerprint();
    this.validateEffectiveConfig(release);
    const containers = this.inspectProjectContainers();
    if (before !== this.configurationFingerprint()) fail("compose_configuration_changed");
    this.databaseContainerId = containers.db.Id;
    this.validatedRelease = releaseKey(release);
    this.release = Object.freeze({ ...release });
    this.validatedConfiguration = before;
    return { containers };
  }

  async projectIsExpected(project, services, release) {
    if (project !== this.project) return false;
    try {
      await this.validateProject(release, services);
      this.lastFailure = null;
      return true;
    } catch (error) {
      this.lastFailure = error instanceof DockerAdapterError ? error.code : "project_validation_failed";
      return false;
    }
  }

  async safeDrain(project, sourceSha, authorization) {
    const current = this.now();
    if (project !== this.project || !SHA.test(sourceSha ?? "") || typeof this.drainVerifier !== "function"
      || !authorization || authorization.project !== project || authorization.source_sha !== sourceSha
      || !DRAIN_ID.test(authorization.id ?? "")
      || authorization.operation_id !== authorization.id
      || !/^[A-Za-z0-9_-]{43}$/.test(authorization.owner_token ?? "")
      || !Number.isInteger(authorization.issued_at) || !Number.isInteger(authorization.expires_at)
      || authorization.issued_at > current || authorization.expires_at <= current
      || authorization.expires_at - authorization.issued_at > 300_000
      || this.usedDrainEvidence.has(authorization.id)) return false;
    if (await this.drainVerifier(Object.freeze({ ...authorization }), {
      phase: "authorize", project, sourceSha,
    }) !== true) return false;
    this.usedDrainEvidence.add(authorization.id);
    this.drainGrant = { project, sourceSha, expiresAt: authorization.expires_at, authorization: Object.freeze({ ...authorization }) };
    return true;
  }

  async assertMutationAuthorized(sourceSha, release) {
    if (this.validatedRelease !== releaseKey(release)
      || this.validatedConfiguration !== this.configurationFingerprint()
      || !this.drainGrant || this.drainGrant.project !== this.project
      || this.drainGrant.sourceSha !== sourceSha || this.drainGrant.expiresAt <= this.now()) {
      fail("safe_drain_required");
    }
    if (await this.drainVerifier(this.drainGrant.authorization, {
      phase: "assert", project: this.project, sourceSha,
    }) !== true) fail("safe_drain_lost");
  }

  verifyLocalImages(release) {
    for (const reference of [release.api_image, release.ui_image]) {
      const inspected = parseJson(
        this.runDocker(["image", "inspect", reference]).stdout,
        "invalid_image_inspection",
      );
      if (!Array.isArray(inspected) || inspected.length !== 1
        || inspected[0].Os !== "linux" || inspected[0].Architecture !== "amd64"
        || !(inspected[0].RepoDigests ?? []).includes(reference)) {
        fail("local_image_digest_mismatch");
      }
    }
  }

  async compose(project, args, sourceSha, release) {
    if (project !== this.project) fail("project_scope_violation");
    assertRelease(release);
    await this.assertMutationAuthorized(sourceSha, release);
    const pull = ["pull", ...UPDATE_SERVICES];
    const up = ["up", "-d", "--no-deps", "--no-build", ...UPDATE_SERVICES];
    const encoded = JSON.stringify(args);
    if (encoded !== JSON.stringify(pull) && encoded !== JSON.stringify(up)) {
      fail("compose_operation_forbidden");
    }
    const isUp = encoded === JSON.stringify(up);
    const result = this.runDocker(this.composeArguments(args), {
      mutating: true,
      environment: this.composeEnvironment(release),
    });
    if (!result.dryRun && !isUp) this.verifyLocalImages(release);
    return result;
  }

  async healthy(plan) {
    if (plan?.project !== this.project || !API_IMAGE.test(plan?.images?.api ?? "")
      || !UI_IMAGE.test(plan?.images?.ui ?? "")) return false;
    try {
      const containers = this.inspectProjectContainers();
      if (containers.db.Id !== this.databaseContainerId
        || containers.api.Config.Image !== plan.images.api
        || containers.worker.Config.Image !== plan.images.api
        || containers.ui.Config.Image !== plan.images.ui) return false;
      await this.assertMutationAuthorized(this.drainGrant?.sourceSha, this.release);
      return true;
    } catch {
      return false;
    }
  }

  healthExec() {
    if (!this.release) fail("project_not_validated");
    return parseJson(this.runDocker(this.composeArguments([
      "exec", "--no-TTY", "api", "node", "dist/deployment-health-cli.js",
    ]), { environment: this.composeEnvironment(this.release) }).stdout, "invalid_health_snapshot");
  }

  validateHealthSnapshot(snapshot) {
    if (!snapshot || snapshot.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(snapshot.version ?? "")
      || !(SHA.test(snapshot.source_sha ?? "") || snapshot.source_sha === "development")
      || !["monitor_count", "enabled_count", "paused_count", "baseline_count", "event_count", "capture_count"].every(
        (key) => Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0,
      ) || !/^[0-9a-f]{64}$/.test(snapshot.monitor_signature ?? "") || !Array.isArray(snapshot.migrations)
      || snapshot.migrations.some((entry, index, list) => !entry || !/^\d{3}_[a-z0-9_]+\.sql$/.test(entry.name ?? "")
        || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "") || (index > 0 && list[index - 1].name >= entry.name))) {
      fail("invalid_health_snapshot");
    }
    return snapshot;
  }

  async captureBaseline() {
    return this.validateHealthSnapshot(this.healthExec());
  }

  runtimeIdentity() {
    const containers = this.inspectProjectContainers();
    const snapshot = this.validateHealthSnapshot(this.healthExec());
    const apiImage = containers.api.Config.Image;
    const workerImage = containers.worker.Config.Image;
    const uiImage = containers.ui.Config.Image;
    if (!API_IMAGE.test(apiImage ?? "") || workerImage !== apiImage || !UI_IMAGE.test(uiImage ?? "")
      || !SHA.test(snapshot.source_sha ?? "")) fail("unverified_runtime_identity");
    return { version: snapshot.version, source_sha: snapshot.source_sha, api_image: apiImage, ui_image: uiImage };
  }

  async verifyDeploymentHealth(plan, baseline) {
    if (!baseline) return false;
    try {
      const containers = this.inspectProjectContainers();
      if (containers.db.Id !== this.databaseContainerId
        || containers.api.Config.Image !== plan.images.api
        || containers.worker.Config.Image !== plan.images.api
        || containers.ui.Config.Image !== plan.images.ui) return false;
      await this.assertMutationAuthorized(this.drainGrant?.sourceSha, this.release);
      const current = this.validateHealthSnapshot(this.healthExec());
      for (const key of ["monitor_count", "enabled_count", "paused_count", "baseline_count", "event_count", "capture_count", "monitor_signature"]) {
        if (current[key] !== baseline[key]) return false;
      }
      if (JSON.stringify(current.migrations) !== JSON.stringify(baseline.migrations)
        || current.source_sha !== this.release.source_sha || current.version !== this.release.version
        || current.maintenance?.state !== "deploying" || current.maintenance?.project !== this.project) return false;
      const signal = AbortSignal.timeout(Math.min(this.timeoutMs, 15_000));
      const [health, ui] = await Promise.all([
        this.fetchImpl(`${this.uiBaseUrl}/api/v1/health`, { signal, redirect: "error" }),
        this.fetchImpl(`${this.uiBaseUrl}/`, { signal, redirect: "error" }),
      ]);
      if (!health.ok || !ui.ok) return false;
      const body = await health.json();
      return body?.status === "ok" && body.version === this.release.version
        && body.source_sha === this.release.source_sha && body.maintenance === true;
    } catch { return false; }
  }

  maintenanceExec(action, payload) {
    if (!this.release || !["begin", "verify", "resume", "fail", "bootstrap-status", "bootstrap-confirm"].includes(action)
      || !payload || typeof payload !== "object") fail("invalid_maintenance_command");
    const input = JSON.stringify(payload);
    if (Buffer.byteLength(input) > 16 * 1024) fail("invalid_maintenance_command");
    return this.runDocker(this.composeArguments([
      "exec", "--no-TTY", "api", "node", "dist/maintenance-cli.js", action,
    ]), { environment: this.composeEnvironment(this.release), input }).stdout;
  }

  completeDrain() { this.drainGrant = null; }
}

export function createDockerComposeHostAdapter(options) {
  return new DockerComposeHostAdapter(options);
}
