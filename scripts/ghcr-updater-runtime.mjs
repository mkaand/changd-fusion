#!/usr/bin/env node
import path from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DeploymentStateStore } from "./deployment-state.mjs";
import { DockerComposeHostAdapter, parseUiHostPort } from "./docker-compose-adapter.mjs";
import { GitHubReleaseClient } from "./github-release-client.mjs";
import { discoverRelease, runUpdater } from "./ghcr-updater.mjs";
import { ComposeMaintenanceCoordinator } from "./maintenance-coordinator.mjs";
import { TelegramUpdaterNotifier } from "./updater-telegram.mjs";

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const TRUSTED_REPOSITORY = "mkaand/changd-fusion";

function required(environment, name) {
  const value = environment[name];
  if (!value || /[\0\r\n]/.test(value)) throw Error(`missing_${name.toLowerCase()}`);
  return value;
}

export function runtimeConfiguration(environment = process.env) {
  const project = required(environment, "FUSION_COMPOSE_PROJECT");
  const projectDirectory = required(environment, "FUSION_PROJECT_DIRECTORY");
  const baseFile = required(environment, "FUSION_COMPOSE_BASE_FILE");
  const overrideFile = required(environment, "FUSION_COMPOSE_OVERRIDE_FILE");
  const stateDirectory = required(environment, "FUSION_UPDATER_STATE_DIRECTORY");
  const envFile = required(environment, "FUSION_COMPOSE_ENV_FILE");
  const dryRun = required(environment, "FUSION_UPDATER_DRY_RUN");
  const uiHostPort = parseUiHostPort(environment.FUSION_UI_HOST_PORT ?? 3000);
  const repository = environment.FUSION_TRUSTED_REPOSITORY ?? TRUSTED_REPOSITORY;
  if (!PROJECT.test(project) || ![projectDirectory, baseFile, overrideFile, stateDirectory, envFile].every(path.isAbsolute)
    || !["0", "1"].includes(dryRun)
    || repository !== TRUSTED_REPOSITORY) throw Error("invalid_updater_configuration");
  return Object.freeze({
    project, projectDirectory, stateDirectory, repository,
    baseFile, overrideFile, envFile, uiHostPort,
    dryRun: dryRun === "1",
    githubToken: environment.FUSION_GITHUB_TOKEN || undefined,
    telegramToken: environment.FUSION_TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: environment.FUSION_TELEGRAM_CHAT_ID || undefined,
  });
}


/**
 * The launcher mounts a minimal, UID-owned read-only Docker configuration.
 * Do not permit ambient credential helpers, foreign registry credentials or
 * Docker contexts: the updater must use the local socket and only GHCR.
 * Never include parsed credential contents or filesystem paths in errors.
 */
export function validateDockerCliConfiguration(environment = process.env) {
  const directory = environment.DOCKER_CONFIG;
  if (!directory) return;
  if (!path.isAbsolute(directory)) throw Error("invalid_docker_config");
  const file = path.join(directory, "config.json");
  let parent;
  try { parent = lstatSync(directory); }
  catch { throw Error("invalid_docker_config"); }
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || parent.uid !== process.getuid() || (parent.mode & 0o777) !== 0o700) {
    throw Error("invalid_docker_config");
  }
  let info;
  try { info = lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") return; // public GHCR needs no credentials
    throw Error("invalid_docker_config");
  }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()
    || (info.mode & 0o777) !== 0o400 || info.size > 131072) {
    throw Error("invalid_docker_config");
  }
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw Error("invalid_docker_config"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw Error("invalid_docker_config");
  }
  if (Object.hasOwn(data, "credsStore") || Object.hasOwn(data, "credHelpers")) {
    throw Error("unsupported_docker_credential_helper");
  }
  if (Object.keys(data).some((key) => key !== "auths")) {
    throw Error("unsupported_docker_configuration");
  }
  const auths = data.auths ?? {};
  if (!auths || typeof auths !== "object" || Array.isArray(auths)) {
    throw Error("invalid_docker_config");
  }
  for (const [registry, credentials] of Object.entries(auths)) {
    if (registry !== "ghcr.io" || !credentials || typeof credentials !== "object"
      || Array.isArray(credentials)
      || Object.entries(credentials).some(([key, value]) =>
        !["auth", "identitytoken"].includes(key) || typeof value !== "string")) {
      throw Error("unsupported_docker_configuration");
    }
  }
}

export async function executeUpdaterRuntime({
  environment = process.env,
  client,
  docker,
  stateStore,
  maintenance,
  telegram,
} = {}) {
  const config = runtimeConfiguration(environment);
  validateDockerCliConfiguration(environment);
  stateStore ??= new DeploymentStateStore({ directory: config.stateDirectory, project: config.project });
  if (!stateStore.acquire()) return { updated: false, reason: "concurrent_updater" };
  try {
    telegram ??= new TelegramUpdaterNotifier({ token: config.telegramToken, chatId: config.telegramChatId });
    let startupState = stateStore.reconcile(stateStore.load());
    if (startupState.status === "RECOVERY_REQUIRED") {
      const operationId = startupState.operation_id;
      if (operationId && startupState.notification?.recovery_operation !== operationId) {
        startupState = stateStore.markRecoveryNotification(startupState, operationId);
        let delivered;
        try { delivered = await telegram.send("recovery_required", { operation_id: operationId, state: startupState.failure?.code ?? "interrupted_deployment" }); }
        catch { delivered = { error: "telegram_delivery_failed" }; }
        if (delivered.error) startupState = stateStore.recordNotificationFailure(startupState, delivered.error);
      }
      return { updated: false, reason: "recovery_required" };
    }
    client ??= new GitHubReleaseClient({ repository: config.repository, token: config.githubToken });
    const evidence = await discoverRelease(client, { repository: config.repository });
    if (!evidence) return { updated: false, reason: "no_update" };
    docker ??= new DockerComposeHostAdapter({
      project: config.project,
      projectDirectory: config.projectDirectory,
      composeFiles: [config.baseFile, config.overrideFile],
      ownershipComposeFiles: [config.baseFile],
      envFile: config.envFile,
      uiHostPort: config.uiHostPort,
      dryRun: config.dryRun,
    });
    maintenance ??= new ComposeMaintenanceCoordinator({ adapter: docker });
    // Do not inspect a potentially incompatible old runtime before its
    // mandatory maintenance bootstrap guard passes.
    const installedBootstrap = await maintenance.bootstrapStatus(config.project);
    const installed = installedBootstrap?.bootstrapped
      ? (startupState.current ?? docker.runtimeIdentity()) : null;
    if (installed?.version === evidence.manifest.version
      && installed.source_sha !== evidence.manifest.source_sha) {
      // A same-version CI publication is not a rollback when the installed
      // master SHA is a proven ancestor. Never infer this from timestamps.
      if (!await client.sourceLineage(installed.source_sha, evidence.manifest.source_sha)) {
        throw Error("installed_source_ancestry_unverified");
      }
      evidence.installedAncestry = {
        from: installed.source_sha, to: evidence.manifest.source_sha, verified: true,
      };
    }
    return await runUpdater({
      evidence,
      config: { project: config.project, dryRun: config.dryRun },
      docker, maintenance, stateStore, telegram,
    });
  } finally { stateStore.release(); }
}

// Systemd must regard a successfully validated dry-run as success even though
// no application containers were changed. A dry-run's lack of mutation is not
// an updater failure.
export function runtimeOutcome(result) {
  if (result?.updated === true) {
    return { status: 0, stdout: "Changd Fusion update completed and verified.\n" };
  }
  if (result?.updated === false && result?.dryRun === true && result?.plan?.dryRun === true
    && result.reason == null) {
    return { status: 0, stdout: "Changd Fusion updater dry-run verification PASS.\n" };
  }
  if (result?.updated === false && ["no_update", "replay"].includes(result.reason)) {
    return { status: 0 };
  }
  const reason = String(result?.reason ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  return { status: 1, stderr: "Changd Fusion updater stopped safely: " + reason + "\n" };
}

// Only static machine-readable error codes may reach systemd journal. Never
// print exception stacks, URLs, Authorization headers, or token-bearing text.
export function safeRuntimeFailureCode(error) {
  const code = error?.message;
  if (typeof code === "string" && /^[a-z][a-z0-9_]{2,100}$/.test(code)) return code;
  // Node.js filesystem errors include paths in message/stack. Only emit
  // allowlisted errno classes; never expose the raw exception or secrets.
  const errno = error?.code;
  if (errno === "EACCES" || errno === "EPERM") return "file_access_denied";
  if (errno === "ENOENT" || errno === "ENOTDIR") return "file_path_unavailable";
  return "runtime_failure";
}

async function main() {
  try {
    const outcome = runtimeOutcome(await executeUpdaterRuntime());
    if (outcome.stdout) process.stdout.write(outcome.stdout);
    if (outcome.stderr) process.stderr.write(outcome.stderr);
    process.exitCode = outcome.status;
  } catch (error) {
    process.stderr.write("Changd Fusion updater stopped safely: " + safeRuntimeFailureCode(error) + "\n");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
