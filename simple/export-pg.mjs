// One-time settings-only export from the old PostgreSQL instance.
// Intended for an isolated, trusted container with existing DATABASE_URL.
// Never prints records, credentials, monitored URLs or private values.
import { Client } from "pg";
import { openSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";

const target=process.env.FUSION_EXPORT_FILE;
if(!target || !path.isAbsolute(target) || !target.endsWith(".json")) throw Error("absolute_export_file_required");
if(!process.env.DATABASE_URL) throw Error("database_url_required");
const client=new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis:5000, statement_timeout:15000 });
let fd,done=false;
try {
  await client.connect();
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const queries={
    users:"SELECT user_id,firstname,lastname,email,password,user_type,status,date_created,last_login FROM users ORDER BY user_id",
    monitors:"SELECT * FROM fusion_monitors ORDER BY id",
    channels:"SELECT * FROM fusion_channels ORDER BY id",
    monitor_channels:"SELECT monitor_id,channel_id FROM fusion_monitor_channels ORDER BY monitor_id,channel_id",
    preferences:"SELECT user_id,monitoring_defaults FROM fusion_user_preferences ORDER BY user_id",
    vault:"SELECT monitor_id,user_id,origin,encrypted,value_names,expires_at,updated_at FROM fusion_monitor_vault ORDER BY monitor_id"
  };
  const bundle={ format:"changd-fusion-pg-settings-v1",created_at:new Date().toISOString(),users:[],monitors:[],channels:[],monitor_channels:[],preferences:[],vault:[] };
  for(const [key,sql] of Object.entries(queries)) bundle[key]=(await client.query(sql)).rows;
  await client.query("COMMIT");
  fd=openSync(target,"wx",0o600);
  writeFileSync(fd,JSON.stringify(bundle));
  done=true;
  process.stdout.write(JSON.stringify({status:"ok",users:bundle.users.length,monitors:bundle.monitors.length,channels:bundle.channels.length,vault:bundle.vault.length})+"\n");
} catch {
  try { await client.query("ROLLBACK"); } catch {}
  // Error descriptions from PG can include sensitive strings.
  process.stderr.write("settings_export_failed\n");
  process.exitCode=1;
} finally {
  if(fd!==undefined) closeSync(fd);
  if(!done && fd!==undefined) try { unlinkSync(target); } catch {}
  await client.end().catch(()=>{});
}
