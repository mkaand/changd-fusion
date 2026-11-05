import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "./db.js";
import { transaction } from "./db.js";
import { CaptureFailure } from "./errors.js";
import type { PoolClient } from "pg";

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CHROMIUM_LOCK_NAMESPACE = 0x43484645;
const CHROMIUM_SLOT = 1;
const MAX_EVIDENCE_TTL_MS = 300_000;

export type MaintenanceState = "draining" | "drained" | "deploying" | "recovery_required";
export type DrainEvidence = {
  id: string;
  operation_id: string;
  project: string;
  source_sha: string;
  issued_at: number;
  expires_at: number;
  owner_token: string;
};
export type RuntimeOperation = { id: string; ownerToken: string };

export class MaintenanceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MaintenanceError"; }
}

function validIdentity(project: string, sourceSha: string, operationId?: string) {
  return PROJECT.test(project) && SHA.test(sourceSha) && (!operationId || UUID.test(operationId));
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function equalHash(actual: unknown, token: string) {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/.test(actual) || !TOKEN.test(token)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(hashToken(token), "hex"));
}

async function chromiumIdle(c: PoolClient) {
  const scheduler = (await c.query("SELECT active_token,active_workload FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE")).rows[0];
  if (!scheduler || scheduler.active_token || scheduler.active_workload) return false;
  const locks = await c.query(
    "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND objid=$2 AND objsubid=2 AND granted LIMIT 1",
    [CHROMIUM_LOCK_NAMESPACE, CHROMIUM_SLOT],
  );
  if (locks.rowCount) return false;
  return !(await c.query("SELECT 1 FROM fusion_runtime_operations LIMIT 1")).rowCount;
}

function verifyEvidenceShape(evidence: DrainEvidence) {
  return evidence && evidence.id === evidence.operation_id && UUID.test(evidence.operation_id)
    && validIdentity(evidence.project, evidence.source_sha, evidence.operation_id)
    && TOKEN.test(evidence.owner_token) && Number.isInteger(evidence.issued_at)
    && Number.isInteger(evidence.expires_at) && evidence.expires_at > evidence.issued_at
    && evidence.expires_at - evidence.issued_at <= MAX_EVIDENCE_TTL_MS;
}

export async function maintenanceActive(pool: Pick<Pool, "query">) {
  const result = await pool.query("SELECT state FROM fusion_maintenance WHERE id=1");
  return result.rowCount === 1;
}

export async function assertBrowserAdmissionOpen(pool: Pool) {
  const open = await transaction(pool, async (c) => {
    await c.query("SELECT id FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE");
    return !(await c.query("SELECT 1 FROM fusion_maintenance WHERE id=1")).rowCount;
  });
  if (!open) throw new CaptureFailure("browser_launch", "capacity_busy", "Browser operations are temporarily paused for maintenance.");
}

export async function browserAdmissionOpen(c: Pick<PoolClient, "query">) {
  return !(await c.query("SELECT 1 FROM fusion_maintenance WHERE id=1")).rowCount;
}

export async function beginRuntimeOperation(pool: Pool, kind: "scheduled_capture" | "manual_check" | "preview"): Promise<RuntimeOperation | null> {
  const id = randomUUID();
  const ownerToken = randomBytes(32).toString("base64url");
  const admitted = await transaction(pool, async (c) => {
    await c.query("SELECT id FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE");
    if (!(await browserAdmissionOpen(c))) return false;
    await c.query(
      "INSERT INTO fusion_runtime_operations(id,owner_token_hash,kind) VALUES($1,$2,$3)",
      [id, hashToken(ownerToken), kind],
    );
    return true;
  });
  return admitted ? { id, ownerToken } : null;
}

export async function finishRuntimeOperation(pool: Pool, operation: RuntimeOperation) {
  if (!UUID.test(operation?.id ?? "") || !TOKEN.test(operation?.ownerToken ?? "")) return false;
  const result = await pool.query(
    "DELETE FROM fusion_runtime_operations WHERE id=$1 AND owner_token_hash=$2 RETURNING id",
    [operation.id, hashToken(operation.ownerToken)],
  );
  return Boolean(result.rowCount);
}

export async function beginMaintenanceDrain(pool: Pool, input: {
  project: string;
  sourceSha: string;
  operationId?: string;
  timeoutMs?: number;
  evidenceTtlMs?: number;
  pollMs?: number;
}): Promise<DrainEvidence> {
  const operationId = input.operationId ?? randomUUID();
  const timeoutMs = Math.min(300_000, Math.max(100, input.timeoutMs ?? 120_000));
  const evidenceTtlMs = Math.min(MAX_EVIDENCE_TTL_MS, Math.max(5_000, input.evidenceTtlMs ?? MAX_EVIDENCE_TTL_MS));
  const pollMs = Math.min(1_000, Math.max(10, input.pollMs ?? 100));
  if (!validIdentity(input.project, input.sourceSha, operationId)) throw new MaintenanceError("invalid_maintenance_identity");
  const ownerToken = randomBytes(32).toString("base64url");
  const inserted = await transaction(pool, async (c) => {
    // Chromium admission and maintenance establishment share this row lock.
    // Whichever commits first defines the safe linearization point.
    await c.query("SELECT id FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE");
    return c.query(
      "INSERT INTO fusion_maintenance(id,project,operation_id,source_sha,owner_token_hash,state) VALUES(1,$1,$2,$3,$4,'draining') ON CONFLICT (id) DO NOTHING RETURNING id",
      [input.project, operationId, input.sourceSha, hashToken(ownerToken)],
    );
  });
  if (!inserted.rowCount) throw new MaintenanceError("maintenance_already_active");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const drained = await transaction(pool, async (c) => {
      const row = (await c.query("SELECT * FROM fusion_maintenance WHERE id=1 FOR UPDATE")).rows[0];
      if (!row || row.operation_id !== operationId || row.state !== "draining" || !equalHash(row.owner_token_hash, ownerToken)) {
        throw new MaintenanceError("maintenance_ownership_lost");
      }
      if (!(await chromiumIdle(c))) return null;
      return (await c.query(
        "UPDATE fusion_maintenance SET state='drained',drained_at=now(),evidence_expires_at=now()+$2*interval '1 millisecond',updated_at=now() WHERE id=1 AND operation_id=$1 AND state='draining' RETURNING extract(epoch FROM drained_at)*1000 AS issued_at,extract(epoch FROM evidence_expires_at)*1000 AS expires_at",
        [operationId, evidenceTtlMs],
      )).rows[0];
    });
    if (drained) return {
      id: operationId,
      operation_id: operationId,
      project: input.project,
      source_sha: input.sourceSha,
      issued_at: Math.floor(Number(drained.issued_at)),
      expires_at: Math.floor(Number(drained.expires_at)),
      owner_token: ownerToken,
    };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
  await pool.query(
    "UPDATE fusion_maintenance SET state='recovery_required',failure_code='drain_timeout',updated_at=now() WHERE id=1 AND operation_id=$1 AND state='draining' AND owner_token_hash=$2",
    [operationId, hashToken(ownerToken)],
  );
  throw new MaintenanceError("drain_timeout");
}

export async function verifyDrainEvidence(pool: Pool, evidence: DrainEvidence, phase: "authorize" | "assert" = "assert") {
  if (!verifyEvidenceShape(evidence) || evidence.expires_at <= Date.now()) return false;
  try {
    return await transaction(pool, async (c) => {
      const row = (await c.query("SELECT * FROM fusion_maintenance WHERE id=1 FOR UPDATE")).rows[0];
      if (!row || row.project !== evidence.project || row.source_sha !== evidence.source_sha
        || row.operation_id !== evidence.operation_id || !equalHash(row.owner_token_hash, evidence.owner_token)
        || Number(new Date(row.evidence_expires_at).getTime()) !== evidence.expires_at
        || Number(new Date(row.drained_at).getTime()) !== evidence.issued_at
        || evidence.expires_at <= Date.now()) return false;
      if (phase === "authorize") {
        if (row.state !== "drained") return false;
        if (!(await chromiumIdle(c))) return false;
        return Boolean((await c.query(
          "UPDATE fusion_maintenance SET state='deploying',updated_at=now() WHERE id=1 AND operation_id=$1 AND state='drained' RETURNING id",
          [evidence.operation_id],
        )).rowCount);
      }
      return row.state === "deploying" && await chromiumIdle(c);
    });
  } catch {
    return false;
  }
}

export async function completeMaintenance(pool: Pool, evidence: DrainEvidence) {
  if (!verifyEvidenceShape(evidence) || evidence.expires_at <= Date.now()) return false;
  return transaction(pool, async (c) => {
    const row = (await c.query("SELECT * FROM fusion_maintenance WHERE id=1 FOR UPDATE")).rows[0];
    if (!row || row.state !== "deploying" || row.operation_id !== evidence.operation_id
      || row.project !== evidence.project || row.source_sha !== evidence.source_sha
      || !equalHash(row.owner_token_hash, evidence.owner_token)
      || Number(new Date(row.evidence_expires_at).getTime()) !== evidence.expires_at
      || Number(new Date(row.drained_at).getTime()) !== evidence.issued_at
      || !(await chromiumIdle(c))) return false;
    return Boolean((await c.query("DELETE FROM fusion_maintenance WHERE id=1 AND operation_id=$1 RETURNING id", [evidence.operation_id])).rowCount);
  });
}

export async function failMaintenance(pool: Pool, evidence: DrainEvidence, failureCode: string) {
  if (!verifyEvidenceShape(evidence) || !/^[a-z0-9_]{1,64}$/.test(failureCode)) return false;
  const result = await pool.query(
    "UPDATE fusion_maintenance SET state='recovery_required',failure_code=$2,updated_at=now() WHERE id=1 AND operation_id=$1 AND project=$3 AND source_sha=$4 AND owner_token_hash=$5 RETURNING id",
    [evidence.operation_id, failureCode, evidence.project, evidence.source_sha, hashToken(evidence.owner_token)],
  );
  return Boolean(result.rowCount);
}

export async function updaterBootstrapStatus(pool: Pool, project: string) {
  if (!PROJECT.test(project)) return { bootstrapped: false, reason: "invalid_project" };
  try {
    const migrations = await pool.query("SELECT name FROM fusion_migrations WHERE name IN ('017_maintenance_drain.sql','018_updater_bootstrap.sql') ORDER BY name");
    if (migrations.rowCount !== 2) return { bootstrapped: false, reason: "schema_missing" };
    const row = (await pool.query("SELECT project,source_sha,confirmed_at FROM fusion_updater_bootstrap WHERE id=1")).rows[0];
    if (!row || row.project !== project || !SHA.test(row.source_sha)) return { bootstrapped: false, reason: "manual_bootstrap_required" };
    return { bootstrapped: true, project: row.project, source_sha: row.source_sha, confirmed_at: new Date(row.confirmed_at).toISOString() };
  } catch { return { bootstrapped: false, reason: "schema_missing" }; }
}

export async function confirmUpdaterBootstrap(pool: Pool, input: { project: string; sourceSha: string; confirmation: string }) {
  if (!validIdentity(input.project, input.sourceSha)
    || input.confirmation !== "I_HAVE_FENCED_V032_API_AND_WORKER") throw new MaintenanceError("bootstrap_confirmation_required");
  return transaction(pool, async (c) => {
    await c.query("SELECT id FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE");
    if ((await c.query("SELECT 1 FROM fusion_maintenance WHERE id=1")).rowCount || !(await chromiumIdle(c))) {
      throw new MaintenanceError("bootstrap_runtime_not_idle");
    }
    const inserted = await c.query(
      "INSERT INTO fusion_updater_bootstrap(id,project,source_sha) VALUES(1,$1,$2) ON CONFLICT (id) DO NOTHING RETURNING project,source_sha,confirmed_at",
      [input.project, input.sourceSha],
    );
    if (!inserted.rowCount) throw new MaintenanceError("bootstrap_already_confirmed");
    return { bootstrapped: true, project: input.project, source_sha: input.sourceSha, confirmed_at: new Date(inserted.rows[0].confirmed_at).toISOString() };
  });
}
