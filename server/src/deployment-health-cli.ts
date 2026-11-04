import { fileURLToPath } from "node:url";
import { makePool } from "./db.js";
import { deploymentHealthSnapshot } from "./deployment-health.js";

export async function runDeploymentHealthCli() {
  const pool = makePool(process.env.DATABASE_URL ?? "");
  try { return await deploymentHealthSnapshot(pool); } finally { await pool.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(await runDeploymentHealthCli()) + "\n"); }
  catch { process.stderr.write(JSON.stringify({ code: "deployment_health_failed" }) + "\n"); process.exitCode = 1; }
}
