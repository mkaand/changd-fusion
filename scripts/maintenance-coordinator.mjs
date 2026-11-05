import { randomUUID } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseResult(value, key) {
  let result;
  try { result = JSON.parse(value); } catch { throw Error("invalid_maintenance_response"); }
  if (!result || typeof result !== "object" || Array.isArray(result) || !(key in result)) {
    throw Error("invalid_maintenance_response");
  }
  return result;
}

export class ComposeMaintenanceCoordinator {
  constructor({ adapter, timeoutMs = 120_000, evidenceTtlMs = 300_000 } = {}) {
    if (!adapter || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000
      || !Number.isInteger(evidenceTtlMs) || evidenceTtlMs < 5_000 || evidenceTtlMs > 300_000) {
      throw Error("invalid_maintenance_configuration");
    }
    this.adapter = adapter;
    this.timeoutMs = timeoutMs;
    this.evidenceTtlMs = evidenceTtlMs;
    adapter.setDrainVerifier?.((evidence, context) => this.verify(evidence, context));
  }

  async drain({ project, sourceSha, operationId = randomUUID() }) {
    if (!PROJECT.test(project ?? "") || !SHA.test(sourceSha ?? "") || !OPERATION_ID.test(operationId)) {
      throw Error("invalid_maintenance_identity");
    }
    return parseResult(this.adapter.maintenanceExec("begin", {
      project,
      source_sha: sourceSha,
      operation_id: operationId,
      timeout_ms: this.timeoutMs,
      evidence_ttl_ms: this.evidenceTtlMs,
    }), "owner_token");
  }

  async verify(evidence, context) {
    if (!context || !["authorize", "assert"].includes(context.phase)) return false;
    try {
      const result = parseResult(this.adapter.maintenanceExec("verify", {
        evidence,
        phase: context.phase,
      }), "valid");
      return result.valid === true;
    } catch { return false; }
  }

  async resume(evidence) {
    const result = parseResult(this.adapter.maintenanceExec("resume", { evidence }), "resumed");
    return result.resumed === true;
  }

  async fail(evidence, failureCode = "deployment_failed") {
    try {
      const result = parseResult(this.adapter.maintenanceExec("fail", {
        evidence, failure_code: failureCode,
      }), "retained");
      return result.retained === true;
    } catch { return false; }
  }

  async bootstrapStatus(project) {
    if (!PROJECT.test(project ?? "")) return { bootstrapped: false, reason: "invalid_project" };
    try {
      const result = parseResult(this.adapter.maintenanceExec("bootstrap-status", { project }), "bootstrapped");
      return result.bootstrapped === true ? result : { bootstrapped: false, reason: String(result.reason ?? "manual_bootstrap_required") };
    } catch { return { bootstrapped: false, reason: "manual_bootstrap_required" }; }
  }
}

export function createMaintenanceDrainVerifier(coordinator) {
  return (evidence, context) => coordinator.verify(evidence, context);
}
