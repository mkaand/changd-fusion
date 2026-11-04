import { createHash } from "node:crypto";
import type { Pool } from "./db.js";
import { APPLICATION_VERSION } from "./version.js";

export async function deploymentHealthSnapshot(pool: Pool) {
  const monitors = await pool.query("SELECT id,enabled,paused,monitor_state,baseline_id,latest_capture_id FROM fusion_monitors ORDER BY id");
  const summary = (await pool.query(`SELECT
    count(*)::int AS monitor_count,
    count(*) FILTER (WHERE enabled)::int AS enabled_count,
    count(*) FILTER (WHERE paused)::int AS paused_count,
    count(*) FILTER (WHERE baseline_id IS NOT NULL)::int AS baseline_count
    FROM fusion_monitors`)).rows[0];
  const history = (await pool.query("SELECT count(*)::int AS event_count FROM fusion_events")).rows[0];
  const captures = (await pool.query("SELECT count(*)::int AS capture_count FROM fusion_captures")).rows[0];
  const migrations = await pool.query("SELECT name,checksum AS sha256 FROM fusion_migrations ORDER BY name");
  const maintenance = (await pool.query("SELECT state,project,operation_id,source_sha FROM fusion_maintenance WHERE id=1")).rows[0] ?? null;
  const monitorSignature = createHash("sha256").update(JSON.stringify(monitors.rows)).digest("hex");
  return {
    schema: 1,
    version: APPLICATION_VERSION,
    source_sha: process.env.APP_COMMIT ?? "development",
    monitor_count: Number(summary.monitor_count), enabled_count: Number(summary.enabled_count),
    paused_count: Number(summary.paused_count), baseline_count: Number(summary.baseline_count),
    event_count: Number(history.event_count), capture_count: Number(captures.capture_count),
    monitor_signature: monitorSignature,
    migrations: migrations.rows,
    maintenance,
  };
}
