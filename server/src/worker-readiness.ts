import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const WORKER_READINESS_SCHEMA = 1;
export const WORKER_READINESS_PATH = "/tmp/changd-fusion-worker/readiness.json";
export const WORKER_HEALTHCHECK_TEST = [
  "CMD",
  "node",
  "dist/worker-healthcheck.js",
  "--json",
] as const;

export const READY_WINDOW_MS = 45_000;
export const TRANSIENT_FAILURE_WINDOW_MS = 15_000;
export const MONITOR_WORK_WINDOW_MS = 140_000;
export const OUTBOX_WORK_WINDOW_MS = 30_000;
export const RETENTION_WORK_WINDOW_MS = 300_000;
const FUTURE_CLOCK_SKEW_MS = 5_000;
const MAX_MARKER_BYTES = 16 * 1024;
const FAILURE_LIMIT = 3;

export type WorkerReadinessPhase =
  | "starting"
  | "ready"
  | "busy"
  | "degraded"
  | "failed"
  | "stopping"
  | "fatal";
export type WorkerOperation = "monitor" | "outbox" | "retention" | null;

export interface WorkerReadinessMarker {
  schema: 1;
  release: string;
  instanceId: string;
  pid: number;
  processStartTicks: string;
  bootId: string;
  phase: WorkerReadinessPhase;
  operation: WorkerOperation;
  updatedAtMs: number;
  validUntilMs: number;
  consecutiveFailures: number;
  sequence: number;
}

export interface WorkerIdentity {
  pid: number;
  processStartTicks: string;
  bootId: string;
  instanceId: string;
}

export interface ReadinessProbe {
  ready: boolean;
  code: string;
  checkedAtMs: number;
  marker?: WorkerReadinessMarker;
}

export interface ReadinessDependencies {
  now: () => number;
  identity: WorkerIdentity;
  write: (marker: WorkerReadinessMarker) => void;
}

function exactRelease(value: string): boolean {
  return value === "development" || /^[0-9a-f]{40}$/.test(value);
}

export function parseProcessStartTicks(stat: string): string {
  const close = stat.lastIndexOf(")");
  if (close < 2 || stat[close + 1] !== " ") throw new Error("invalid-process-stat");
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const ticks = fields[19]; // /proc/<pid>/stat field 22; fields starts at field 3.
  if (!ticks || !/^[1-9][0-9]*$/.test(ticks)) throw new Error("invalid-process-starttime");
  return ticks;
}

export function currentWorkerIdentity(pid = process.pid): WorkerIdentity {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(bootId))
    throw new Error("invalid-boot-id");
  return {
    pid,
    processStartTicks: parseProcessStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8")),
    bootId,
    instanceId: randomUUID(),
  };
}

function secureDirectory(directory: string) {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const st = lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
    throw new Error("unsafe-readiness-directory");
}

export function atomicWriteMarker(markerPath: string, marker: WorkerReadinessMarker) {
  const directory = path.dirname(markerPath);
  secureDirectory(directory);
  const temporary = `${markerPath}.${marker.instanceId}.${marker.sequence}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(marker) + "\n", "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, markerPath);
}

function windowFor(marker: WorkerReadinessMarker): number | undefined {
  if (marker.phase === "ready" && marker.operation === null) return READY_WINDOW_MS;
  if (marker.phase === "degraded" && marker.operation === null) return TRANSIENT_FAILURE_WINDOW_MS;
  if (marker.phase !== "busy") return undefined;
  if (marker.operation === "monitor") return MONITOR_WORK_WINDOW_MS;
  if (marker.operation === "outbox") return OUTBOX_WORK_WINDOW_MS;
  if (marker.operation === "retention") return RETENTION_WORK_WINDOW_MS;
  return undefined;
}

const MARKER_KEYS = new Set([
  "schema",
  "release",
  "instanceId",
  "pid",
  "processStartTicks",
  "bootId",
  "phase",
  "operation",
  "updatedAtMs",
  "validUntilMs",
  "consecutiveFailures",
  "sequence",
]);

export function validateMarker(value: unknown): WorkerReadinessMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-marker");
  const marker = value as WorkerReadinessMarker;
  if (
    Object.keys(marker).length !== MARKER_KEYS.size ||
    Object.keys(marker).some((key) => !MARKER_KEYS.has(key)) ||
    marker.schema !== WORKER_READINESS_SCHEMA ||
    !exactRelease(marker.release) ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(marker.instanceId) ||
    !Number.isSafeInteger(marker.pid) ||
    marker.pid <= 0 ||
    !/^[1-9][0-9]*$/.test(marker.processStartTicks) ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(marker.bootId) ||
    !["starting", "ready", "busy", "degraded", "failed", "stopping", "fatal"].includes(marker.phase) ||
    ![null, "monitor", "outbox", "retention"].includes(marker.operation) ||
    !Number.isSafeInteger(marker.updatedAtMs) ||
    !Number.isSafeInteger(marker.validUntilMs) ||
    !Number.isSafeInteger(marker.consecutiveFailures) ||
    marker.consecutiveFailures < 0 ||
    !Number.isSafeInteger(marker.sequence) ||
    marker.sequence < 1
  )
    throw new Error("invalid-marker");
  return marker;
}

export class WorkerReadiness {
  private sequence = 0;
  private failures = 0;
  private initialized = false;
  private terminal = false;
  private lastReadyWrite = 0;

  constructor(
    readonly release: string,
    private readonly dependencies: ReadinessDependencies,
  ) {
    if (!exactRelease(release)) throw new Error("invalid-worker-release");
  }

  static system(release: string, markerPath = WORKER_READINESS_PATH) {
    return new WorkerReadiness(release, {
      now: Date.now,
      identity: currentWorkerIdentity(),
      write: (marker) => atomicWriteMarker(markerPath, marker),
    });
  }

  private publish(phase: WorkerReadinessPhase, operation: WorkerOperation, windowMs = 0) {
    const now = this.dependencies.now();
    this.sequence += 1;
    this.dependencies.write({
      schema: WORKER_READINESS_SCHEMA,
      release: this.release,
      ...this.dependencies.identity,
      phase,
      operation,
      updatedAtMs: now,
      validUntilMs: now + windowMs,
      consecutiveFailures: this.failures,
      sequence: this.sequence,
    });
    if (phase === "ready") this.lastReadyWrite = now;
  }

  start() {
    this.publish("starting", null);
  }

  initializedProgress() {
    if (this.terminal) return;
    if (!this.initialized) {
      this.initialized = true;
      this.failures = 0;
      this.publish("ready", null, READY_WINDOW_MS);
    } else if (this.failures > 0) {
      this.publish("degraded", null, TRANSIENT_FAILURE_WINDOW_MS);
    } else if (this.dependencies.now() - this.lastReadyWrite >= 10_000) {
      this.publish("ready", null, READY_WINDOW_MS);
    }
  }

  busy(operation: Exclude<WorkerOperation, null>, requestedWindowMs?: number) {
    if (this.terminal || !this.initialized) return;
    const window =
      operation === "monitor"
        ? MONITOR_WORK_WINDOW_MS
        : operation === "outbox"
          ? OUTBOX_WORK_WINDOW_MS
          : RETENTION_WORK_WINDOW_MS;
    this.publish("busy", operation, Math.min(window, requestedWindowMs ?? window));
  }

  cycleSucceeded() {
    if (this.terminal || !this.initialized) return;
    const recovered = this.failures > 0;
    this.failures = 0;
    const now = this.dependencies.now();
    if (recovered || now - this.lastReadyWrite >= 10_000) this.publish("ready", null, READY_WINDOW_MS);
  }

  cycleFailed() {
    if (this.terminal) return;
    this.failures += 1;
    this.publish(
      this.failures >= FAILURE_LIMIT ? "failed" : "degraded",
      null,
      this.failures >= FAILURE_LIMIT ? 0 : TRANSIENT_FAILURE_WINDOW_MS,
    );
  }

  stopping() {
    if (this.terminal) return;
    this.terminal = true;
    this.publish("stopping", null);
  }

  fatal() {
    if (this.terminal) return;
    this.terminal = true;
    this.publish("fatal", null);
  }
}

export interface ProbeDependencies {
  now: () => number;
  read: (markerPath: string) => string;
  stat: (markerPath: string) => { isFile(): boolean; isSymbolicLink(): boolean; uid: number; mode: number; size: number; mtimeMs: number };
  processStartTicks: (pid: number) => string;
  bootId: () => string;
  uid: () => number;
}

export function systemProbeDependencies(): ProbeDependencies {
  return {
    now: Date.now,
    read: (markerPath) => readFileSync(markerPath, "utf8"),
    stat: (markerPath) => lstatSync(markerPath),
    processStartTicks: (pid) => parseProcessStartTicks(readFileSync(`/proc/${pid}/stat`, "utf8")),
    bootId: () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    uid: () => process.getuid?.() ?? -1,
  };
}

export function probeWorkerReadiness(
  markerPath: string,
  expectedRelease: string,
  dependencies: ProbeDependencies = systemProbeDependencies(),
): ReadinessProbe {
  const checkedAtMs = dependencies.now();
  try {
    if (!exactRelease(expectedRelease)) throw new Error("invalid-expected-release");
    const st = dependencies.stat(markerPath);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.uid !== dependencies.uid() ||
      (st.mode & 0o077) !== 0 ||
      st.size <= 0 ||
      st.size > MAX_MARKER_BYTES
    )
      throw new Error("unsafe-marker-file");
    const marker = validateMarker(JSON.parse(dependencies.read(markerPath)));
    const window = windowFor(marker);
    if (
      marker.release !== expectedRelease ||
      marker.bootId !== dependencies.bootId() ||
      marker.processStartTicks !== dependencies.processStartTicks(marker.pid) ||
      window === undefined ||
      marker.updatedAtMs > checkedAtMs + FUTURE_CLOCK_SKEW_MS ||
      marker.validUntilMs < checkedAtMs ||
      marker.validUntilMs < marker.updatedAtMs ||
      marker.validUntilMs - marker.updatedAtMs > window ||
      st.mtimeMs + FUTURE_CLOCK_SKEW_MS < marker.updatedAtMs ||
      st.mtimeMs > checkedAtMs + FUTURE_CLOCK_SKEW_MS ||
      (marker.phase === "degraded" && (marker.consecutiveFailures < 1 || marker.consecutiveFailures >= FAILURE_LIMIT)) ||
      (marker.phase === "busy" && marker.consecutiveFailures >= FAILURE_LIMIT) ||
      (!["degraded", "busy"].includes(marker.phase) && marker.consecutiveFailures !== 0)
    )
      throw new Error("readiness-contract-failed");
    return { ready: true, code: "ready", checkedAtMs, marker };
  } catch {
    return { ready: false, code: "not-ready", checkedAtMs };
  }
}
