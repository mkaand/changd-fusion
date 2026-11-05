import { fileURLToPath } from "node:url";
import { makePool } from "./db.js";
import { beginMaintenanceDrain, completeMaintenance, confirmUpdaterBootstrap, failMaintenance, updaterBootstrapStatus, verifyDrainEvidence, type DrainEvidence } from "./maintenance.js";

const MAX_INPUT = 16 * 1024;

async function readInput() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT) throw Error("maintenance_input_too_large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_maintenance_input");
  return value as Record<string, unknown>;
}

export async function runMaintenanceCli(action: string, input: Record<string, unknown>) {
  const pool = makePool(process.env.DATABASE_URL ?? "");
  try {
    if (action === "begin") return beginMaintenanceDrain(pool, {
      project: String(input.project ?? ""), sourceSha: String(input.source_sha ?? ""),
      operationId: input.operation_id ? String(input.operation_id) : undefined,
      timeoutMs: Number(input.timeout_ms ?? 120_000), evidenceTtlMs: Number(input.evidence_ttl_ms ?? 300_000),
    });
    if (action === "bootstrap-status") return updaterBootstrapStatus(pool, String(input.project ?? ""));
    if (action === "bootstrap-confirm") return confirmUpdaterBootstrap(pool, {
      project: String(input.project ?? ""), sourceSha: String(input.source_sha ?? ""), confirmation: String(input.confirmation ?? ""),
    });
    const evidence = input.evidence as DrainEvidence;
    if (action === "verify") return { valid: await verifyDrainEvidence(pool, evidence, input.phase === "authorize" ? "authorize" : "assert") };
    if (action === "resume") return { resumed: await completeMaintenance(pool, evidence) };
    if (action === "fail") return { retained: await failMaintenance(pool, evidence, String(input.failure_code ?? "deployment_failed")) };
    throw Error("invalid_maintenance_action");
  } finally { await pool.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const output = await runMaintenanceCli(String(process.argv[2] ?? ""), await readInput());
    process.stdout.write(JSON.stringify(output) + "\n");
  } catch {
    process.stderr.write(JSON.stringify({ code: "maintenance_command_failed" }) + "\n");
    process.exitCode = 1;
  }
}
