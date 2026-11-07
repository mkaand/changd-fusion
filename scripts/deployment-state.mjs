import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const STATES = new Set(["IDLE", "PREPARING", "DRAINING", "DEPLOYING", "VERIFYING", "SUCCESS", "FAILED", "RECOVERY_REQUIRED"]);
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA = /^[0-9a-f]{40}$/;
const IMAGE = /^ghcr\.io\/mkaand\/changd-fusion-(?:api|ui)@sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_STATE_BYTES = 64 * 1024;
const TRANSITIONS = Object.freeze({
  IDLE: new Set(["PREPARING", "FAILED", "RECOVERY_REQUIRED"]),
  PREPARING: new Set(["DRAINING", "FAILED", "RECOVERY_REQUIRED"]),
  DRAINING: new Set(["DEPLOYING", "FAILED", "RECOVERY_REQUIRED"]),
  DEPLOYING: new Set(["VERIFYING", "RECOVERY_REQUIRED"]),
  VERIFYING: new Set(["SUCCESS", "RECOVERY_REQUIRED"]),
  SUCCESS: new Set(["PREPARING", "FAILED", "RECOVERY_REQUIRED"]),
  FAILED: new Set(["PREPARING", "FAILED", "RECOVERY_REQUIRED"]),
  RECOVERY_REQUIRED: new Set(["RECOVERY_REQUIRED"]),
});

function validRelease(value) {
  return value === null || (value && /^\d+\.\d+\.\d+$/.test(value.version)
    && SHA.test(value.source_sha) && IMAGE.test(value.api_image) && IMAGE.test(value.ui_image));
}

export function validateDeploymentState(value, expectedProject) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== 1
    || !PROJECT.test(value.project ?? "") || value.project !== expectedProject
    || !STATES.has(value.status) || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || !Number.isSafeInteger(value.updated_at) || value.updated_at < 0
    || typeof value.maintenance_released !== "boolean"
    || (value.operation_id !== null && !UUID.test(value.operation_id ?? ""))
    || !validRelease(value.current) || !validRelease(value.previous) || !validRelease(value.candidate)
    || (value.failure !== null && (!value.failure || typeof value.failure !== "object"
      || !/^[A-Za-z0-9_]{1,64}$/.test(value.failure.code ?? "")
      || !/^[A-Za-z0-9_]{1,64}$/.test(value.failure.stage ?? "")))
    || (!value.notification || typeof value.notification !== "object"
      || (value.notification.success_operation !== null && !UUID.test(value.notification.success_operation ?? ""))
      || (value.notification.recovery_operation !== null && !UUID.test(value.notification.recovery_operation ?? ""))
      || (value.notification.error !== null && !/^[a-z0-9_]{1,64}$/.test(value.notification.error ?? "")))) {
    throw Error("invalid_deployment_state");
  }
  if (["PREPARING", "DRAINING", "DEPLOYING", "VERIFYING"].includes(value.status)
    && (!value.operation_id || !validRelease(value.candidate))) throw Error("inconsistent_deployment_state");
  if (value.status === "SUCCESS" && (!value.current || value.candidate !== null)) throw Error("inconsistent_deployment_state");
  return Object.freeze(structuredClone(value));
}

function secureDirectory(directory) {
  try { mkdirSync(directory, { mode: 0o700, recursive: true }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw Error("unsafe_state_directory");
}

export class DeploymentStateStore {
  constructor({ directory, project, now = Date.now } = {}) {
    if (!PROJECT.test(project ?? "") || !path.isAbsolute(directory ?? "")) throw Error("invalid_state_configuration");
    secureDirectory(directory);
    this.directory = directory;
    this.project = project;
    this.now = now;
    this.statePath = path.join(directory, "deployment-state.json");
    this.lockPath = path.join(directory, "updater.lock");
    this.lockFd = null;
  }

  initial() {
    return { schema: 1, project: this.project, status: "IDLE", sequence: 0, updated_at: this.now(), operation_id: null,
      current: null, previous: null, candidate: null, failure: null,
      maintenance_released: true,
      notification: { success_operation: null, recovery_operation: null, error: null } };
  }

  load({ allowMissing = true } = {}) {
    try {
      const st = lstatSync(this.statePath);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0
        || st.size <= 0 || st.size > MAX_STATE_BYTES || st.nlink !== 1) throw Error("unsafe_state_file");
      return validateDeploymentState(JSON.parse(readFileSync(this.statePath, "utf8")), this.project);
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissing) return Object.freeze(this.initial());
      if (["SyntaxError", "TypeError"].includes(error?.name)) throw Error("invalid_deployment_state");
      throw error;
    }
  }

  acquire() {
    try {
      this.lockFd = openSync(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(this.lockFd, `${process.pid}\n`, "utf8");
      fsyncSync(this.lockFd);
      return true;
    } catch (error) { if (error?.code === "EEXIST") return false; throw error; }
  }

  release() {
    if (this.lockFd === null) return;
    closeSync(this.lockFd); this.lockFd = null;
    try { unlinkSync(this.lockPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }

  write(next) {
    const current = this.load();
    const value = validateDeploymentState({ ...next, schema: 1, project: this.project,
      sequence: current.sequence + 1, updated_at: this.now() }, this.project);
    if (value.sequence <= current.sequence) throw Error("state_rollback");
    const temporary = path.join(this.directory, `.deployment-state.${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value) + "\n", "utf8"); fsyncSync(fd); closeSync(fd);
      renameSync(temporary, this.statePath);
    } catch (error) {
      try { closeSync(fd); } catch {}
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
    const dirFd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return value;
  }

  transition(state, status, changes = {}) {
    if (!STATES.has(status)) throw Error("invalid_deployment_transition");
    if (!TRANSITIONS[state?.status]?.has(status)) throw Error("invalid_deployment_transition");
    return this.write({ ...state, ...changes, status });
  }

  reconcile(state) {
    if (["PREPARING", "DRAINING", "DEPLOYING", "VERIFYING"].includes(state.status)
      || (state.status === "SUCCESS" && !state.maintenance_released)) {
      return this.transition(state, "RECOVERY_REQUIRED", { failure: { code: "interrupted_deployment", stage: state.status.toLowerCase() } });
    }
    return state;
  }

  // Explicit operator adoption of a separately verified, already-running release.
  // This records observation as IDLE, never fabricates an updater SUCCESS.
  adoptVerifiedInstalled(expected, release) {
    const state = this.load();
    if (state.sequence !== expected?.sequence || state.status !== "FAILED"
      || state.failure?.code !== "BOOTSTRAP_REQUIRED" || state.failure?.stage !== "bootstrap"
      || state.current !== null || state.previous !== null || state.candidate !== null
      || state.operation_id !== null || state.maintenance_released !== true
      || !validRelease(release) || release === null) {
      throw Error("adoption_state_unsafe");
    }
    return this.write({
      ...state, status: "IDLE", current: structuredClone(release),
      failure: null, operation_id: null, candidate: null,
    });
  }

  markNotification(state, operationId, error = null) {
    return this.write({ ...state, notification: { ...state.notification,
      success_operation: error ? state.notification?.success_operation ?? null : operationId, error } });
  }

  recordNotificationFailure(state, error) {
    if (!/^[a-z0-9_]{1,64}$/.test(error ?? "")) throw Error("invalid_notification_error");
    return this.write({ ...state, notification: { ...state.notification, error } });
  }

  markRecoveryNotification(state, operationId) {
    if (!UUID.test(operationId ?? "")) throw Error("invalid_notification_operation");
    return this.write({ ...state, notification: { ...state.notification, recovery_operation: operationId, error: null } });
  }
}
