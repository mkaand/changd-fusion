import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const SCHEMA_VERSION = 1;
export function openSimpleDatabase(filename) {
  if (!path.isAbsolute(filename)) throw Error("sqlite_path_must_be_absolute");
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  db.exec([
    "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));",
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,refresh_hash TEXT NOT NULL UNIQUE,expires_at INTEGER NOT NULL,refresh_expires_at INTEGER NOT NULL);",
    "CREATE TABLE IF NOT EXISTS monitors (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload)),next_run INTEGER NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),paused INTEGER NOT NULL CHECK(paused IN (0,1)),last_status TEXT NOT NULL DEFAULT 'waiting_baseline',last_run INTEGER,last_success INTEGER,failure_count INTEGER NOT NULL DEFAULT 0);",
    "CREATE INDEX IF NOT EXISTS monitors_due ON monitors(enabled,paused,next_run);",
    "CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload)));",
    "CREATE TABLE IF NOT EXISTS monitor_channels (monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,PRIMARY KEY(monitor_id,channel_id));",
    "CREATE TABLE IF NOT EXISTS preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload)));",
    "CREATE TABLE IF NOT EXISTS vault (monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload)));",
    "CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY,monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,text_content TEXT,screenshot TEXT,http_status INTEGER,created_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS captures_monitors ON captures(monitor_id,created_at DESC);",
    "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,before_id TEXT REFERENCES captures(id),after_id TEXT REFERENCES captures(id),status TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),created_at INTEGER NOT NULL);",
    "CREATE INDEX IF NOT EXISTS events_monitor_date ON events(monitor_id,created_at DESC);",
    "CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',next_attempt INTEGER NOT NULL,payload TEXT NOT NULL DEFAULT '{}',UNIQUE(event_id,channel_id));,
    "CREATE TABLE IF NOT EXISTS notification_digests (monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,first_event_at INTEGER NOT NULL,last_event_at INTEGER NOT NULL,event_count INTEGER NOT NULL,latest_event_id TEXT REFERENCES events(id) ON DELETE CASCADE,due_at INTEGER NOT NULL,PRIMARY KEY(monitor_id,channel_id));"
  ].join("\n"));
  db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  if (db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()?.value !== String(SCHEMA_VERSION)) {
    db.close();
    throw Error("unsupported_schema_version");
  }
  try { chmodSync(filename, 0o600); } catch {}
  return db;
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    if (value instanceof Promise) throw Error("asynchronous_sqlite_transaction_forbidden");
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function decode(value) { return typeof value === "string" ? JSON.parse(value) : value; }
function ensureUuid(value, type) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw Error("invalid_" + type + "_id");
  return value;
}
export function getMonitor(db, id, userId) {
  const row = db.prepare("SELECT * FROM monitors WHERE id=? AND user_id=?").get(id,userId);
  if (!row) return null;
  const monitor = JSON.parse(row.payload);
  return { ...monitor, id: row.id, user_id: row.user_id, enabled: !!row.enabled,
    paused: !!row.paused, monitor_state: row.last_status, failure_count: row.failure_count,
    last_run: row.last_run ? new Date(row.last_run).toISOString() : null,
    last_success_at: row.last_success ? new Date(row.last_success).toISOString() : null,
    next_run: new Date(row.next_run).toISOString() };
}
export function listMonitors(db,userId) {
  return db.prepare("SELECT id FROM monitors WHERE user_id=? ORDER BY json_extract(payload,'$.created_at') DESC,id DESC").all(userId)
    .map(row=>getMonitor(db,row.id,userId));
}
export function saveMonitor(db, monitor, userId, { replace=false }={}) {
  ensureUuid(monitor.id,"monitor");
  const now=Date.now();
  const parsed=Date.parse(monitor.next_run);
  const next=Number.isFinite(parsed) ? parsed : now;
  const status=String(monitor.monitor_state ?? "waiting_baseline");
  const encoded=JSON.stringify({ ...monitor, id: monitor.id, user_id:userId });
  if (replace) {
    const r=db.prepare("UPDATE monitors SET payload=?,next_run=?,enabled=?,paused=?,last_status=? WHERE id=? AND user_id=?")
      .run(encoded,next,monitor.enabled!==false?1:0,monitor.paused===true?1:0,status,monitor.id,userId);
    if (!r.changes) throw Error("monitor_not_found");
  } else {
    db.prepare("INSERT INTO monitors(id,user_id,payload,next_run,enabled,paused,last_status) VALUES(?,?,?,?,?,?,?)")
      .run(monitor.id,userId,encoded,next,monitor.enabled!==false?1:0,monitor.paused===true?1:0,status);
  }
}
export function userCount(db) { return db.prepare("SELECT count(*) AS count FROM users").get().count; }
export function importConfiguration(db, bundle, { channelKey }={}) {
  if (!bundle || bundle.format !== "changd-fusion-pg-settings-v1"
      || !Array.isArray(bundle.users) || !Array.isArray(bundle.monitors)
      || !Array.isArray(bundle.channels) || !Array.isArray(bundle.monitor_channels)
      || !Array.isArray(bundle.preferences) || !Array.isArray(bundle.vault)) {
    throw Error("invalid_configuration_bundle");
  }
  if ((bundle.channels.length||bundle.vault.length) && !/^[a-f0-9]{64}$/i.test(channelKey??"")) throw Error("original_channel_key_required");
  if (userCount(db) || db.prepare("SELECT count(*) AS n FROM monitors").get().n)
    throw Error("configuration_import_requires_empty_database");
  return transaction(db,()=>{
    const users=new Set(), monitors=new Map(), channels=new Map();
    for(const user of bundle.users) {
      const id=ensureUuid(user.user_id,"user");
      if (users.has(id) || !user.email || typeof user.password !== "string" || user.password.length < 20)
        throw Error("invalid_imported_user");
      users.add(id);
      db.prepare("INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)")
        .run(id,user.email.toLowerCase(),user.password,JSON.stringify(Object.fromEntries(Object.entries(user).filter(([k])=>k!=="password"))));
    }
    for(const item of bundle.monitors) {
      if(!users.has(item.user_id)) throw Error("import_monitor_owner_missing");
      const id=ensureUuid(item.id,"monitor");
      if(monitors.has(id)) throw Error("import_monitor_duplicate");
      monitors.set(id,item.user_id);
      saveMonitor(db,{...item,baseline_id:null,latest_capture_id:null,monitor_state:item.enabled===false?"disabled":item.paused?"paused":"waiting_baseline",next_run:new Date().toISOString(),failure_count:0},item.user_id);
    }
    for(const item of bundle.channels) {
      if(!users.has(item.user_id)||!item.config?.encrypted || typeof item.config.encrypted !=="string") throw Error("invalid_imported_channel");
      const id=ensureUuid(item.id,"channel");
      if(channels.has(id)) throw Error("import_channel_duplicate");
      channels.set(id,item.user_id);
      db.prepare("INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)").run(id,item.user_id,JSON.stringify(item));
    }
    for(const link of bundle.monitor_channels) {
      const owner=monitors.get(link.monitor_id);
      if(!owner || owner!==channels.get(link.channel_id)) throw Error("invalid_imported_channel_link");
      db.prepare("INSERT INTO monitor_channels(monitor_id,channel_id) VALUES(?,?)").run(link.monitor_id,link.channel_id);
    }
    for(const pref of bundle.preferences) {
      if(!users.has(pref.user_id)) throw Error("invalid_imported_preference");
      db.prepare("INSERT INTO preferences(user_id,payload) VALUES(?,?)").run(pref.user_id,JSON.stringify(pref.monitoring_defaults??{}));
    }
    for(const row of bundle.vault) {
      if(!monitors.has(row.monitor_id)||row.user_id!==monitors.get(row.monitor_id)||typeof row.encrypted!=="string")
        throw Error("invalid_imported_vault");
      db.prepare("INSERT INTO vault(monitor_id,user_id,payload) VALUES(?,?,?)").run(row.monitor_id,row.user_id,JSON.stringify(row));
    }
    if(channelKey) db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('channel_key',?)").run(channelKey);
    db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('imported_at',?)").run(new Date().toISOString());
    return { users:users.size,monitors:monitors.size,channels:channels.size,vault:bundle.vault.length };
  });
}
export function newId() { return randomUUID(); }
