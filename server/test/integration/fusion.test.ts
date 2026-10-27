import { test, before, after, mock, type TestContext } from "node:test";
import { closeServer, listenServer } from "../helpers/server.js";
import assert from "node:assert/strict";
import request from "supertest";
import { makePool, type Pool } from "../../src/db.js";
import { migrate } from "../../src/migrate.js";
import { createApp } from "../../src/app.js";
import { runMonitor, retainHistory } from "../../src/engine.js";
import { dispatch } from "../../src/outbox.js";
import { workerCycle } from "../../src/worker.js";
import { readConfig, type Config } from "../../src/config.js";
import { capture } from "../../src/capture.js";
import { CaptureFailure, SchedulingCancellation } from "../../src/errors.js";
import { EgressPolicy } from "../../src/egress.js";
import { encrypt, decrypt } from "../../src/crypto.js";
import { PNG } from "pngjs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { mkdtemp, rm, readFile, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { seedPreview } from "../../src/preview-seed.js";
import { compareVisual } from "../../src/comparison.js";
import { telegramSummary } from "../../src/notifications.js";
import { closeRegionPreviewSessions, expireRegionPreviewSessions, previewRegion, REGION_PREVIEW_MAX_LIFETIME_MS } from "../../src/region-picker.js";
import { acquireChromiumLease, createInteractivePriorityIntent, cancelInteractivePriorityIntent } from "../../src/chromium-capacity.js";
import { recoverChromiumQuarantine } from "../../src/chromium-recovery.js";
import { spawn } from "node:child_process";
import { applySelectedTextRule, generateSelectedTextRule } from "../../src/selected-text.js";
const expectedMigrationCount = (await readdir(path.resolve(import.meta.dirname, "../../migrations"))).filter((file) => /^\d+_.+\.sql$/.test(file)).length;
const dbURL = new URL(process.env.TEST_DATABASE_URL ?? "");
assert.ok(
  ["127.0.0.1", "localhost"].includes(dbURL.hostname),
  "Integration tests require an explicitly local disposable PostgreSQL server",
);
const dbName = "fusion_test_" + randomUUID().replaceAll("-", "");
const admin = makePool(dbURL.href);
let pool: Pool,
  cfg: Config,
  app: ReturnType<typeof createApp>,
  ownerAgent: any,
  otherAgent: any,
  monitor: any,
  channelId: string,
  root: string;
const password = "synthetic-fixture-password";
function managedServer(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  t.after(() => closeServer(server));
  return server;
}
function image(changed = 0, width = 100, height = 100) {
  const p = new PNG({ width, height });
  p.data.fill(255);
  for (let i = 0; i < changed; i++) {
    p.data[i * 4] = p.data[i * 4 + 1] = p.data[i * 4 + 2] = 0;
  }
  return PNG.sync.write(p);
}
function previewImage() {
  const p = new PNG({ width: 1280, height: 900 });
  p.data.fill(245);
  for (let y = 160; y < 240; y++) for (let x = 160; x < 520; x++) {
    const offset = (y * p.width + x) * 4;
    p.data[offset] = 38; p.data[offset + 1] = 112; p.data[offset + 2] = 191; p.data[offset + 3] = 255;
  }
  return PNG.sync.write(p);
}
before(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`);
  dbURL.pathname = "/" + dbName;
  pool = makePool(dbURL.href);
  root = await mkdtemp(path.join(os.tmpdir(), "fusion-integration-"));
  cfg = readConfig({
    NODE_ENV: "test",
    DATABASE_URL: dbURL.href,
    JWT_SECRET: randomBytes(32).toString("hex"),
    CHANNEL_KEY: randomBytes(32).toString("hex"),
    DATA_DIR: root,
    PLAYWRIGHT_EXECUTABLE_PATH: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    LOG_LEVEL: "silent",
  });
  await migrate(pool);
  await migrate(pool);
  const hashed = await hash(password, 4);
  await pool.query(
    "INSERT INTO users(email,password,firstname,lastname,user_type) VALUES($1,$3,$4,$5,0),($2,$3,$4,$5,0)",
    ["owner@example.com", "other@example.com", hashed, "Fixture", "User"],
  );
  app = createApp(
    pool,
    cfg,
    new EgressPolicy(async () => [{ address: "8.8.8.8", family: 4 }]),
    { telegramValidate: async () => ({ first_name: "Fixture Bot", username: "fixture_bot" }) },
  );
  ownerAgent = request.agent(app);
  otherAgent = request.agent(app);
  for (const [agent, email] of [
    [ownerAgent, "owner@example.com"],
    [otherAgent, "other@example.com"],
  ])
    await agent
      .post("/api/v1/login")
      .set("X-Fusion-Request", "1")
      .send({ email, password })
      .expect(200);
});
after(async () => {
  await closeRegionPreviewSessions();
  try {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally {
    try {
      await admin.end();
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
    }
  }
});
test("fresh migration is repeatable and decimal columns are NUMERIC", async () => {
  const r = await pool.query(
    "SELECT data_type FROM information_schema.columns WHERE table_name='fusion_events' AND column_name='visual_percent'",
  );
  assert.equal(r.rows[0].data_type, "numeric");
  assert.equal(
    (await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name='fusion_monitors' AND column_name='keyword'")).rows[0].data_type,
    "text",
  );
  assert.equal(Number((await pool.query("SELECT count(*) FROM fusion_migrations")).rows[0].count), expectedMigrationCount);
});
test("migration 013 through current preserves existing monitors, baselines, and history", async () => {
  const name = "fusion_upgrade_014_" + randomUUID().replaceAll("-", "");
  const url = new URL(dbURL);
  url.pathname = "/" + name;
  const upgrade = makePool(url.href);
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    await upgrade.query("CREATE TABLE fusion_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const migrationDir = path.resolve(import.meta.dirname, "../../migrations");
    const migrations = (await readdir(migrationDir)).filter((file) => /^0(?:0[1-9]|1[0-3])_.+\.sql$/.test(file)).sort();
    assert.equal(migrations.at(-1), "013_selected_area_capture.sql");
    for (const migration of migrations) {
      const sql = await readFile(path.join(migrationDir, migration), "utf8");
      await upgrade.query("BEGIN");
      try {
        await upgrade.query(sql);
        await upgrade.query("INSERT INTO fusion_migrations(name,checksum) VALUES($1,$2)", [migration, createHash("sha256").update(sql).digest("hex")]);
        await upgrade.query("COMMIT");
      } catch (error) {
        await upgrade.query("ROLLBACK");
        throw error;
      }
    }
    await upgrade.query("INSERT INTO users(user_id,email,password) VALUES('upgrade-owner','upgrade@example.com','synthetic-hash')");
    const full = (await upgrade.query("INSERT INTO fusion_monitors(user_id,name,url,kind,text_source,extraction_mode) VALUES('upgrade-owner','Existing full text','https://example.com/full','browser','direct','full_text') RETURNING id")).rows[0];
    const selected = (await upgrade.query("INSERT INTO fusion_monitors(user_id,name,url,kind,text_source,extraction_mode,extraction_rule) VALUES('upgrade-owner','Existing selected text','https://example.com/selected','browser','jina','selected_text',$1::jsonb) RETURNING id", [JSON.stringify({ version: 1, kind: "bounded_context", before: "Before", after: "After", max_length: 80 })])).rows[0];
    await upgrade.query("UPDATE fusion_monitors SET notify_failures=true WHERE id=$1", [selected.id]);
    const baseline = randomUUID();
    await upgrade.query("INSERT INTO fusion_captures(id,monitor_id,text_content) VALUES($1,$2,'Preserved baseline')", [baseline, full.id]);
    await upgrade.query("UPDATE fusion_monitors SET baseline_id=$2,latest_capture_id=$2 WHERE id=$1", [full.id, baseline]);
    await upgrade.query("INSERT INTO fusion_events(monitor_id,after_id,status) VALUES($1,$2,'baseline')", [full.id, baseline]);
    await migrate(upgrade);
    await migrate(upgrade);
    const rows = (await upgrade.query("SELECT id,extraction_mode,extraction_rule,keyword,capture_area,capture_timeout_ms,baseline_id,latest_capture_id,monitor_http_error_pages,failure_alert_mode,last_http_status FROM fusion_monitors ORDER BY name")).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.extraction_mode).sort(), ["full_text", "selected_text"]);
    assert.ok(rows.every((row) => row.keyword === null));
    assert.ok(rows.every((row) => row.capture_area === null));
    assert.ok(rows.every((row) => row.capture_timeout_ms === null));
    assert.ok(rows.every((row) => row.monitor_http_error_pages === false));
    assert.ok(rows.every((row) => row.last_http_status === null));
    assert.equal(rows.find((row) => row.id === full.id)?.failure_alert_mode, "off");
    assert.equal(rows.find((row) => row.id === selected.id)?.failure_alert_mode, "first_or_persistent");
    assert.equal(rows.find((row) => row.id === full.id)?.baseline_id, baseline);
    assert.equal(rows.find((row) => row.id === full.id)?.latest_capture_id, baseline);
    assert.equal(rows.find((row) => row.id === selected.id)?.extraction_rule.kind, "bounded_context");
    assert.equal((await upgrade.query("SELECT count(*) FROM fusion_events WHERE monitor_id=$1", [full.id])).rows[0].count, "1");
    assert.equal(Number((await upgrade.query("SELECT count(*) FROM fusion_migrations")).rows[0].count), expectedMigrationCount);
    await assert.rejects(() => upgrade.query("UPDATE fusion_monitors SET extraction_mode='keyword_presence',keyword=NULL WHERE id=$1", [full.id]));
    await assert.rejects(() => upgrade.query("UPDATE fusion_monitors SET capture_area='{\"x\":0,\"y\":0,\"width\":20,\"height\":20}'::jsonb WHERE id=$1", [full.id]));
    await assert.rejects(() => upgrade.query("UPDATE fusion_monitors SET capture_mode='selected_area',capture_area='{\"x\":1270,\"y\":0,\"width\":20,\"height\":20}'::jsonb WHERE id=$1", [full.id]));
    await assert.rejects(() => upgrade.query("UPDATE fusion_monitors SET capture_timeout_ms=60001 WHERE id=$1", [full.id]));
  } finally {
    await upgrade.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  }
});
test("JWT, admin checks, CSRF, disabled registration and removed scheduler endpoint", async () => {
  await request(app).get("/api/v1/jobs").expect(401);
  await request(app).get("/api/v1/system/diagnostics").expect(401);
  await ownerAgent.get("/api/v1/system/diagnostics").expect(200, {
    api: "ok",
    monitoring: { active: 0, total: 0, attention: 0 },
    deliveries: { pending: 0, failed: 0 },
    retention_days: cfg.HISTORY_DAYS,
  });
  await ownerAgent.get("/api/v1/users").expect(403);
  const user = (await ownerAgent.get("/api/v1/users/me").expect(200)).body;
  const forged = jwt.sign({ sub: user.user_id, admin: true }, cfg.JWT_SECRET, {
    algorithm: "HS384",
    issuer: "changd-fusion",
    audience: "changd-fusion-ui",
  });
  await request(app)
    .get("/api/v1/users")
    .set("Authorization", "Bearer " + forged)
    .expect(401);
  await request(app)
    .post("/api/v1/login")
    .send({ email: "owner@example.com", password })
    .expect(403);
  await ownerAgent
    .post("/api/v1/jobs")
    .set("X-Fusion-Request", "1")
    .set("Origin", "https://example.com")
    .send({})
    .expect(403);
  await request(app)
    .post("/api/v1/register")
    .set("X-Fusion-Request", "1")
    .send({ email: "fixture@example.com", password })
    .expect(403);
  await ownerAgent.get("/api/v1/checkjobs").expect(404);
});
test("monitor validation rejects private URLs, injection, foreign channels; all operations enforce ownership", async () => {
  const foreign = (
    await otherAgent
      .post("/api/v1/notifications")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Other channel",
        provider: "telegram",
        config: { token: "123456:" + "x".repeat(24), chat_id: "123456" },
      })
      .expect(201)
  ).body;
  await ownerAgent
    .post("/api/v1/jobs")
    .set("X-Fusion-Request", "1")
    .send({
      name: "Blocked",
      url: "http://169.254.169.254",
      text_enabled: true,
    })
    .expect(400);
  await ownerAgent
    .post("/api/v1/jobs")
    .set("X-Fusion-Request", "1")
    .send({
      name: "Injection",
      url: "https://example.com",
      interval_seconds: "30); DROP TABLE users;--",
    })
    .expect(400);
  const body = {
    name: "Hybrid fixture",
    url: "https://example.com",
    kind: "browser",
    text_enabled: true,
    visual_enabled: true,
    visual_threshold: "0.34",
    pixel_threshold: 0.1,
  };
  await ownerAgent
    .post("/api/v1/jobs")
    .set("X-Fusion-Request", "1")
    .send({ ...body, channel_ids: [foreign.id] })
    .expect(404);
  monitor = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send(body)
      .expect(201)
  ).body;
  const ch = (
    await ownerAgent
      .post("/api/v1/notifications")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Synthetic",
        provider: "telegram",
        config: { token: "123456:" + "x".repeat(24), chat_id: "123456" },
      })
      .expect(201)
  ).body;
  channelId = ch.id;
  assert.ok(!("token" in ch.config));
  await pool.query("INSERT INTO fusion_monitor_channels VALUES($1,$2)", [
    monitor.id,
    ch.id,
  ]);
  for (const p of ["/jobs/" + monitor.id, "/jobs/" + monitor.id + "/history"])
    await otherAgent.get("/api/v1" + p).expect(404);
  for (const verb of ["put", "delete"] as const)
    await otherAgent[verb]("/api/v1/jobs/" + monitor.id)
      .set("X-Fusion-Request", "1")
      .send(body)
      .expect(404);
  for (const action of ["run", "reset"])
    await otherAgent
      .post("/api/v1/jobs/" + monitor.id + "/" + action)
      .set("X-Fusion-Request", "1")
      .send({})
      .expect(404);
  await otherAgent
    .delete("/api/v1/notifications/" + ch.id)
    .set("X-Fusion-Request", "1")
    .expect(404);
  await otherAgent
    .put("/api/v1/notifications/" + ch.id)
    .set("X-Fusion-Request", "1")
    .send({})
    .expect(404);
  await otherAgent
    .post("/api/v1/notifications/" + ch.id + "/test")
    .set("X-Fusion-Request", "1")
    .send({ monitor_id: monitor.id })
    .expect(404);
  await ownerAgent
    .post("/api/v1/notifications/" + ch.id + "/validate")
    .set("X-Fusion-Request", "1")
    .send({})
    .expect(200)
    .expect((r) => {
      assert.deepEqual(r.body, { valid: true, bot: { first_name: "Fixture Bot", username: "fixture_bot" } });
    });
  await otherAgent
    .post("/api/v1/notifications/" + ch.id + "/validate")
    .set("X-Fusion-Request", "1")
    .send({})
    .expect(404);
});
test("system diagnostics uses owner-scoped monitor and delivery states", async (t) => {
  const ownerId = (await pool.query("SELECT user_id FROM users WHERE email='owner@example.com'"))
    .rows[0].user_id;
  const otherId = (await pool.query("SELECT user_id FROM users WHERE email='other@example.com'"))
    .rows[0].user_id;
  const ownerAttention = (
    await pool.query(
      "INSERT INTO fusion_monitors(user_id,name,url,kind,text_enabled,visual_enabled,monitor_state,last_error) VALUES($1,$2,$3,'browser',true,false,'persistent_failure','Synthetic failure') RETURNING id",
      [ownerId, "Diagnostics attention", "https://example.com/diagnostics-owner"],
    )
  ).rows[0].id;
  const otherAttention = (
    await pool.query(
      "INSERT INTO fusion_monitors(user_id,name,url,kind,text_enabled,visual_enabled,monitor_state,last_error) VALUES($1,$2,$3,'browser',true,false,'challenge_detected','Synthetic failure') RETURNING id",
      [otherId, "Other diagnostics attention", "https://example.com/diagnostics-other"],
    )
  ).rows[0].id;
  t.after(async () => {
    await pool.query("DELETE FROM fusion_monitors WHERE id=ANY($1::uuid[])", [[ownerAttention, otherAttention]]);
  });
  const otherChannel = (await pool.query("SELECT id FROM fusion_channels WHERE user_id=$1 LIMIT 1", [otherId])).rows[0];
  assert.ok(otherChannel, "fixture must provide the other owner's channel");
  const ownerEvents = await pool.query(
    "INSERT INTO fusion_events(monitor_id,status) VALUES($1,'failed'),($1,'failed'),($1,'failed') RETURNING id",
    [ownerAttention],
  );
  await pool.query(
    "INSERT INTO fusion_outbox(event_id,channel_id,status) VALUES($1,$2,'pending'),($3,$2,'sending'),($4,$2,'failed')",
    [ownerEvents.rows[0].id, channelId, ownerEvents.rows[1].id, ownerEvents.rows[2].id],
  );
  const otherEvent = (await pool.query("INSERT INTO fusion_events(monitor_id,status) VALUES($1,'failed') RETURNING id", [otherAttention])).rows[0];
  await pool.query("INSERT INTO fusion_outbox(event_id,channel_id,status) VALUES($1,$2,'pending')", [otherEvent.id, otherChannel.id]);

  await ownerAgent.get("/api/v1/system/diagnostics").expect(200, {
    api: "ok",
    monitoring: { active: 1, total: 2, attention: 1 },
    deliveries: { pending: 2, failed: 1 },
    retention_days: cfg.HISTORY_DAYS,
  });
  await otherAgent.get("/api/v1/system/diagnostics").expect(200, {
    api: "ok",
    monitoring: { active: 0, total: 1, attention: 1 },
    deliveries: { pending: 1, failed: 0 },
    retention_days: cfg.HISTORY_DAYS,
  });
});
test("owner-scoped timeline and analytics filter event history without exposing another owner", async () => {
  await pool.query(
    "INSERT INTO fusion_events(monitor_id,status,text_changed,created_at) VALUES($1,'changed',true,now()-interval '1 day'),($1,'failed',false,now())",
    [monitor.id],
  );
  const timeline = await ownerAgent
    .get(`/api/v1/timeline?monitor_id=${monitor.id}&status=changed&page=1&page_size=25`);
  assert.equal(timeline.status, 200, JSON.stringify(timeline.body));
  assert.ok(timeline.body.total >= 1);
  assert.ok(timeline.body.items.every((event: any) => event.monitor_id === monitor.id && event.status === "changed"));
  const analytics = await ownerAgent
    .get(`/api/v1/analytics?monitor_id=${monitor.id}`);
  assert.equal(analytics.status, 200, JSON.stringify(analytics.body));
  assert.ok(Number(analytics.body.summary.total) >= 2);
  assert.ok(Number(analytics.body.summary.changed) >= 1);
  assert.ok(Number(analytics.body.summary.failed) >= 1);
  assert.ok(analytics.body.trend.length >= 1);
  await otherAgent.get(`/api/v1/timeline?monitor_id=${monitor.id}`).expect(200).expect((response: any) => {
    assert.equal(response.body.total, 0);
    assert.deepEqual(response.body.items, []);
  });
  await otherAgent.get(`/api/v1/analytics?monitor_id=${monitor.id}`).expect(200).expect((response: any) => {
    assert.equal(Number(response.body.summary.total), 0);
  });
  await ownerAgent.get("/api/v1/timeline?from=not-a-date").expect(400);
  await ownerAgent
    .get("/api/v1/timeline?from=2026-01-02T00%3A00%3A00.000Z&to=2026-01-01T00%3A00%3A00.000Z")
    .expect(400);
});
test("hybrid precision: 0.35% → PostgreSQL → API → notification, one event and one outbox entry", async () => {
  const take = (text: string, pixels: number) => async () => ({
    text,
    screenshot: image(pixels),
  });
  await runMonitor(pool, cfg, monitor.id, {
    force: true,
    capture: take("Price 10", 0),
  });
  const initial = (
    await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [
      monitor.id,
    ])
  ).rows[0].baseline_id;
  await runMonitor(pool, cfg, monitor.id, {
    force: true,
    capture: take("Price 11", 35),
  });
  const after = (
    await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [monitor.id])
  ).rows[0];
  assert.notEqual(after.baseline_id, initial);
  assert.equal(after.last_percent, "0.3500000000");
  const history = (
    await ownerAgent.get("/api/v1/jobs/" + monitor.id + "/history").expect(200)
  ).body;
  const event = history.find((e: any) => e.status === "changed");
  assert.equal(event.visual_percent, "0.3500000000");
  assert.equal(event.text_changed, true);
  assert.equal(event.visual_changed, true);
  assert.notEqual(event.before_image, event.after_image);
  await ownerAgent.get("/api/v1/screenshots/" + event.before_image).expect(200);
  await otherAgent.get("/api/v1/screenshots/" + event.before_image).expect(404);
  await request(app)
    .get("/api/v1/screenshots/" + event.before_image)
    .expect(401);
  assert.equal(
    (await pool.query("SELECT count(*) FROM fusion_outbox")).rows[0].count,
    "1",
  );
  const sent: any[] = [];
  await dispatch(pool, cfg, async (_p, _c, e) => {
    sent.push(e);
  });
  await dispatch(pool, cfg, async (_p, _c, e) => {
    sent.push(e);
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].percent, "0.3500000000");
  assert.ok(sent[0].textSummary.includes("Price 11"));
  assert.ok(telegramSummary(sent[0]).includes("0.35%"));
  assert.ok(sent[0].checkedAt instanceof Date);
  assert.equal(sent[0].attempt, 1);
  // Unchanged pixels are valid captures with 0%, no alert and a separate latest capture.
  await runMonitor(pool, cfg, monitor.id, {
    force: true,
    capture: take("Price 11", 35),
  });
  const unchanged = (
    await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [monitor.id])
  ).rows[0];
  assert.equal(unchanged.last_percent, "0.0000000000");
  assert.equal(unchanged.baseline_id, after.baseline_id);
  assert.notEqual(unchanged.latest_capture_id, after.latest_capture_id);
  await runMonitor(pool, cfg, monitor.id, {
    force: true,
    capture: async () => {
      throw Error("synthetic capture failure with private details");
    },
  });
  const failed = (
    await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [monitor.id])
  ).rows[0];
  assert.equal(failed.baseline_id, after.baseline_id);
  assert.equal(failed.latest_capture_id, unchanged.latest_capture_id);
  assert.ok(!failed.last_error.includes("private details"));
  assert.equal(failed.failure_count, 1);
});
test("failed image comparison preserves baseline and latest capture", async () => {
  const before = (
    await pool.query(
      "SELECT baseline_id,latest_capture_id FROM fusion_monitors WHERE id=$1",
      [monitor.id],
    )
  ).rows[0];
  await runMonitor(pool, cfg, monitor.id, {
    force: true,
    capture: async () => ({
      text: "Changed but invalid image",
      screenshot: Buffer.from("corrupt image"),
    }),
  });
  const after = (
    await pool.query(
      "SELECT baseline_id,latest_capture_id FROM fusion_monitors WHERE id=$1",
      [monitor.id],
    )
  ).rows[0];
  assert.deepEqual(after, before);
});

test("selected text values keep chronological baselines and existing notification delivery semantics", async () => {
  const selectedApp = createApp(pool, cfg, new EgressPolicy(async () => [{ address: "8.8.8.8", family: 4 }]));
  const selectedAgent = request.agent(selectedApp), isolatedOther = request.agent(selectedApp);
  await selectedAgent.post("/api/v1/login").set("X-Fusion-Request", "1").send({ email: "owner@example.com", password }).expect(200);
  await isolatedOther.post("/api/v1/login").set("X-Fusion-Request", "1").send({ email: "other@example.com", password }).expect(200);
  await selectedAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Invalid selected text", url: "https://example.com", kind: "browser", text_enabled: true, visual_enabled: false, text_source: "jina", extraction_mode: "selected_text" }).expect(400);
  await selectedAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Malformed selected text", url: "https://example.com/malformed", kind: "browser", text_enabled: true, visual_enabled: false, text_source: "jina", extraction_mode: "selected_text", extraction_rule: { version: 1, kind: "bounded_context", before: "", after: "", max_length: 0 } }).expect(400);
  const selectedChannel = (await selectedAgent.post("/api/v1/notifications").set("X-Fusion-Request", "1").send({ name: "Selected value channel", provider: "telegram", config: { token: "123456:" + "s".repeat(24), chat_id: "654321" } }).expect(201)).body;
  const selected = (await selectedAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Selected value history", url: "https://example.com/product", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "jina", extraction_mode: "selected_text", extraction_rule: { version: 1, kind: "bounded_context", before: "Availability\n", after: "\nDelivery", max_length: 80 },
    channel_ids: [selectedChannel.id],
  }).expect(201)).body;
  assert.equal(selected.extraction_mode, "selected_text");
  assert.equal(selected.extraction_rule.before, "Availability\n");
  const persisted = (await selectedAgent.get(`/api/v1/jobs/${selected.id}`).expect(200)).body;
  assert.deepEqual(persisted.extraction_rule, selected.extraction_rule);
  const longSelectedLine = "A".repeat(205) + "unique-prefix-" + "33.499,00 TL" + "-unique-suffix" + "B".repeat(205);
  const generatedV2 = generateSelectedTextRule(["Product", "Current price", longSelectedLine, "Seller", "Delivery"], 2, "33.499,00 TL").rule;
  assert.equal(generatedV2.prefix.length, 160);
  assert.equal(generatedV2.suffix.length, 160);
  const selectedV2 = (await selectedAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Schema-bounded V2 selection", url: "https://example.com/product-v2", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "jina", extraction_mode: "selected_text", extraction_rule: generatedV2, paused: true,
  }).expect(201)).body;
  assert.deepEqual(selectedV2.extraction_rule, generatedV2, "server-generated V2 rules pass the monitor persistence schema intact");
  const selectedV2Updated = (await selectedAgent.put(`/api/v1/jobs/${selectedV2.id}`).set("X-Fusion-Request", "1").send({
    name: "Schema-bounded V2 selection updated", url: "https://example.com/product-v2", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "jina", extraction_mode: "selected_text", extraction_rule: generatedV2, paused: true,
  }).expect(200)).body;
  assert.deepEqual(selectedV2Updated.extraction_rule, generatedV2, "V2 rules survive existing-monitor PUT persistence intact");
  const replacementRule = { version: 1, kind: "bounded_context", before: "Availability\n", after: "\nDelivery", max_length: 96 };
  const updated = (await selectedAgent.put(`/api/v1/jobs/${selected.id}`).set("X-Fusion-Request", "1").send({
    name: "Selected value history", url: "https://example.com/product", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "jina", extraction_mode: "selected_text", extraction_rule: replacementRule, channel_ids: [selectedChannel.id],
  }).expect(200)).body;
  assert.deepEqual(updated.extraction_rule, replacementRule);
  await selectedAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Invalid direct special mode", url: "https://example.com/direct-invalid", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "direct", extraction_mode: "unsupported_mode",
  }).expect(400);
  const direct = (await selectedAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Direct source after Jina", url: "https://example.com/direct", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "direct", extraction_mode: "full_text", extraction_rule: selected.extraction_rule,
  }).expect(201)).body;
  assert.equal(direct.text_source, "direct");
  assert.equal(direct.extraction_mode, "full_text");
  assert.equal(direct.extraction_rule.before, "Availability\n", "switching source does not erase the reusable Jina rule");
  await isolatedOther.get(`/api/v1/jobs/${selected.id}`).expect(404);
  const take = (value: string, unrelated = "Standard delivery") => runMonitor(pool, cfg, selected.id, { force: true, capture: async (stored) => ({
    text: applySelectedTextRule(`Availability\n${value}\nDelivery\n${unrelated}`, stored.extraction_rule!), screenshot: null,
  }) });
  await take("32.999,00 TL");
  await take("32.999,00 TL", "Updated delivery copy");
  const beforeChange = (await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [selected.id])).rows[0].baseline_id;
  await take("31.999,00 TL");
  const afterChange = (await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [selected.id])).rows[0].baseline_id;
  assert.notEqual(afterChange, beforeChange);
  await runMonitor(pool, cfg, selected.id, { force: true, capture: async () => { throw new Error("synthetic Reader match failure"); } });
  assert.equal((await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [selected.id])).rows[0].baseline_id, afterChange, "failed extraction preserves the selected-value baseline");
  const events = (await pool.query("SELECT status,text_changed FROM fusion_events WHERE monitor_id=$1 ORDER BY created_at", [selected.id])).rows;
  assert.deepEqual(events.filter((event) => event.status !== "reset").slice(0, 3).map((event) => event.status), ["baseline", "unchanged", "changed"]);
  assert.equal(events.find((event) => event.status === "changed")?.text_changed, true);
  assert.equal(Number((await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [selected.id])).rows[0].count), 1);
  await pool.query("UPDATE fusion_outbox o SET status='sent',delivered_at=now() FROM fusion_events e WHERE o.event_id=e.id AND e.monitor_id=$1", [selected.id]);
  await pool.query("UPDATE fusion_monitors SET paused=true,next_run=now()+interval '1 day' WHERE id=$1", [selected.id]);
  await pool.query("UPDATE fusion_monitors SET paused=true,next_run=now()+interval '1 day' WHERE id=$1", [direct.id]);
});

test("keyword presence persists for Direct Browser and Jina and emits only filtered presence transitions", async () => {
  const headers = { "X-Fusion-Request": "1" };
  const keywordApp = createApp(pool, cfg, new EgressPolicy(async () => [{ address: "8.8.8.8", family: 4 }]));
  const keywordAgent = request.agent(keywordApp);
  await keywordAgent.post("/api/v1/login").set(headers).send({ email: "owner@example.com", password }).expect(200);
  await keywordAgent.post("/api/v1/jobs").set(headers).send({
    name: "Missing keyword", url: "https://example.com/missing", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "direct", extraction_mode: "keyword_presence",
  }).expect(400);
  await keywordAgent.post("/api/v1/jobs").set(headers).send({
    name: "Empty keyword", url: "https://example.com/empty", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "direct", extraction_mode: "keyword_presence", keyword: "   ",
  }).expect(400);
  await keywordAgent.post("/api/v1/jobs").set(headers).send({
    name: "Oversized keyword", url: "https://example.com/long", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "direct", extraction_mode: "keyword_presence", keyword: "x".repeat(201),
  }).expect(400);
  await keywordAgent.post("/api/v1/jobs").set(headers).send({
    name: "Invalid keyword target", url: "https://example.com/api", kind: "api", text_enabled: true, visual_enabled: false,
    text_source: "direct", extraction_mode: "keyword_presence", keyword: "Kaan",
  }).expect(400);
  const jina = (await keywordAgent.post("/api/v1/jobs").set(headers).send({
    name: "Jina keyword", url: "https://example.com/jina", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "jina", extraction_mode: "keyword_presence", keyword: "Kaan", paused: true,
  }).expect(201)).body;
  assert.equal(jina.keyword, "Kaan");
  assert.equal(jina.extraction_mode, "keyword_presence");

  const createKeywordMonitor = async (name: string, direction: "added" | "removed" | "both") =>
    (await keywordAgent.post("/api/v1/jobs").set(headers).send({
      name, url: `https://example.com/${direction}`, kind: "browser", text_enabled: true, visual_enabled: false,
      text_source: "direct", extraction_mode: "keyword_presence", keyword: "Kaan", text_direction: direction,
      channel_ids: [channelId],
    }).expect(201)).body;
  const take = (id: string, text: string) => runMonitor(pool, cfg, id, { force: true, capture: async () => ({ text, screenshot: null }) });

  const both = await createKeywordMonitor("Keyword both", "both");
  await take(both.id, "No matching word");
  await take(both.id, "Kaan is present");
  const presentBaseline = (await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [both.id])).rows[0].baseline_id;
  await take(both.id, "Kaan remains while unrelated page text changes");
  assert.equal((await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [both.id])).rows[0].baseline_id, presentBaseline, "unrelated text changes do not advance a keyword baseline");
  await runMonitor(pool, cfg, both.id, { force: true, capture: async () => { throw new Error("synthetic keyword capture failure"); } });
  assert.equal((await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [both.id])).rows[0].baseline_id, presentBaseline, "capture failure preserves the last known presence state");
  await take(both.id, "No matching word after capture recovery");
  const bothEvents = (await pool.query("SELECT status,text_changed,text_diff,notification_state FROM fusion_events WHERE monitor_id=$1 ORDER BY created_at,id", [both.id])).rows;
  assert.deepEqual(bothEvents.filter((event) => event.status !== "failed").map((event) => event.status), ["baseline", "changed", "unchanged", "changed"]);
  assert.deepEqual(bothEvents.filter((event) => event.status === "changed").map((event) => event.text_diff), [
    [{ value: "Kaan", added: true, removed: false }],
    [{ value: "Kaan", added: false, removed: true }],
  ]);
  assert.ok(bothEvents.filter((event) => event.status === "changed").every((event) => event.notification_state === "queued"));

  const added = await createKeywordMonitor("Keyword added", "added");
  await take(added.id, "Absent");
  await take(added.id, "Kaan present");
  await take(added.id, "Absent again");
  assert.deepEqual((await pool.query("SELECT notification_state FROM fusion_events WHERE monitor_id=$1 AND status='changed' ORDER BY created_at,id", [added.id])).rows.map((event) => event.notification_state), ["queued", "direction_filtered"]);

  const removed = await createKeywordMonitor("Keyword removed", "removed");
  await take(removed.id, "Kaan present");
  await take(removed.id, "Absent");
  await take(removed.id, "Kaan present again");
  assert.deepEqual((await pool.query("SELECT notification_state FROM fusion_events WHERE monitor_id=$1 AND status='changed' ORDER BY created_at,id", [removed.id])).rows.map((event) => event.notification_state), ["queued", "direction_filtered"]);
  await pool.query("DELETE FROM fusion_monitors WHERE id=ANY($1::uuid[])", [[jina.id, both.id, added.id, removed.id]]);
});

test("same-monitor concurrency is rejected and configuration mutations cannot race captures", async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const active = runMonitor(pool, cfg, monitor.id, {
    force: true,
    capture: async () => {
      entered();
      await gate;
      return { text: "Price 11", screenshot: image(35) };
    },
  });
  try {
    await started;
    assert.equal(
      await runMonitor(pool, cfg, monitor.id, {
        force: true,
        capture: async () => {
          throw Error("must not execute");
        },
      }),
      false,
    );
    await ownerAgent
      .post("/api/v1/jobs/" + monitor.id + "/reset")
      .set("X-Fusion-Request", "1")
      .send({})
      .expect(409);
  } finally {
    release();
    await active;
  }
});
test("outbox retries and restart status preserve event uniqueness", async () => {
  await ownerAgent
    .post("/api/v1/notifications/" + channelId + "/test")
    .set("X-Fusion-Request", "1")
    .send({ monitor_id: monitor.id })
    .expect(202);
  await dispatch(pool, cfg, async () => {
    throw Error("synthetic provider failure");
  });
  const r = await pool.query(
    "SELECT * FROM fusion_outbox WHERE status='pending'",
  );
  assert.equal(r.rowCount, 1);
  assert.equal(r.rows[0].attempts, 1);
  await pool.query(
    "UPDATE fusion_outbox SET status='sending',next_attempt=now() WHERE id=$1",
    [r.rows[0].id],
  );
  let deliveries = 0;
  await dispatch(
    pool,
    cfg,
    async () => {
      deliveries++;
    },
    { stopped: () => true },
  );
  assert.equal(deliveries, 0);
  await dispatch(pool, cfg, async () => {
    deliveries++;
  });
  assert.equal(deliveries, 1);
  await dispatch(pool, cfg, async () => {
    deliveries++;
  });
  assert.equal(deliveries, 1);
});
test("real Playwright hybrid capture uses one session, selectors, masks, normalization and private subresource isolation", async (t) => {
  let subresourceHits = 0;
  const privateServer = managedServer(t, (_req, res) => {
    subresourceHits++;
    res.end("private");
  });
  await listenServer(privateServer);
  const privatePort = (privateServer.address() as AddressInfo).port;
  const fixture = managedServer(t, (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<main id="content"> Price   10 <span class="dynamic">time</span></main><aside hidden>Hidden state</aside><template>Template state</template><script type="application/json">{"props":{"session":"changes"}}</script><style>.never{display:none}</style><div class="never">Invisible state</div><img src="http://127.0.0.1:${privatePort}/private"><script>fetch('http://169.254.169.254/')</script>`,
    );
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async (host) =>
      host === "fixture.test" ? [{ address: "127.0.0.1", family: 4 }] : [],
    (ip) => ip === "127.0.0.1",
    new Set([port]),
  );
  try {
    const m = {
      ...monitor,
      url: `http://fixture.test:${port}`,
      selector: "#content",
      selector_type: "css",
      ignore_selectors: [".dynamic"],
      mask_selectors: ["#content"],
      ignore_text: [],
      normalize_whitespace: true,
      ignore_case: false,
    };
    const result = await capture(m, cfg, policy);
    assert.equal(result.text, "Price 10");
    assert.ok(result.screenshot?.length);
    assert.ok((result.timings?.font_wait ?? -1) >= 0);
    assert.equal(subresourceHits, 0);
    const xpath = await capture(
      {
        ...m,
        selector: "//main",
        selector_type: "xpath",
        visual_enabled: false,
      },
      cfg,
      policy,
    );
    assert.equal(xpath.text, "Price 10");
    assert.equal(xpath.timings?.font_wait, undefined);
    const defaultText = await capture(
      {
        ...m,
        selector: "",
        ignore_selectors: [],
        visual_enabled: false,
      },
      cfg,
      policy,
    );
    assert.ok(defaultText.text?.includes("Price 10"));
    for (const hidden of ["Hidden state", "Template state", "session", "Invisible state"])
      assert.ok(!defaultText.text?.includes(hidden), hidden);
  } finally {
    await closeServer(fixture);
    await closeServer(privateServer);
  }
});
test("text-only browser capture does not wait for an irrelevant stalled font", async (t) => {
  const fixture = managedServer(t, (req, res) => {
    if (req.url === "/slow.woff2") return;
    if (req.url === "/font.css") {
      res.setHeader("Content-Type", "text/css");
      res.end('@font-face{font-family:slow;src:url("/slow.woff2")} main{font-family:slow}');
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end('<link rel="stylesheet" href="/font.css"><main>Font-independent text</main>');
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async () => [{ address: "127.0.0.1", family: 4 }],
    () => true,
    new Set([port]),
  );
  const started = Date.now();
  const result = await capture(
    {
      ...monitor,
      url: `http://fixture.test:${port}`,
      text_enabled: true,
      visual_enabled: false,
      selector: "",
      ignore_selectors: [],
      browser_steps: [],
    },
    { ...cfg, CAPTURE_TIMEOUT_MS: 1500 },
    policy,
  );
  assert.equal(result.text, "Font-independent text");
  assert.ok(Date.now() - started < 1500);
  assert.equal(result.timings?.font_wait, undefined);
  for (const stage of ["target_validation", "browser_launch", "navigation", "attention_detection", "text_extraction"])
    assert.ok((result.timings as Record<string, number>)[stage] >= 0, stage);
});
test("visible browser text ignores hydration across repeated captures, detects real changes and preserves disabled notifications", async (t) => {
  let hydration = "A", title = "Example Feature", state = "Open";
  const fixture = managedServer(t, (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(`<main><h1>${title}</h1><p>Status: ${state}</p></main><script type="application/json">${JSON.stringify({ props: { hydration, logged_in: false, color_mode: "light" } })}</script><div hidden>internal ${hydration}</div>`);
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async (host) => host === "fixture.test" ? [{ address: "127.0.0.1", family: 4 }] : [],
    (ip) => ip === "127.0.0.1",
    new Set([port]),
  );
  const created = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Hydration fixture",
        url: "https://example.com/hydration-fixture",
        kind: "browser",
        text_enabled: true,
        visual_enabled: false,
        visual_threshold: "0.35",
        pixel_threshold: 0.1,
      })
      .expect(201)
  ).body;
  await pool.query("INSERT INTO fusion_monitor_channels VALUES($1,$2)", [created.id, channelId]);
  await pool.query("UPDATE fusion_monitors SET url=$2 WHERE id=$1", [created.id, `http://fixture.test:${port}`]);
  const take = (m: any, config: Config) => capture(m, config, policy);
  await runMonitor(pool, cfg, created.id, { force: true, capture: take });
  for (let i = 0; i < 20; i++) {
    hydration = `dynamic-${i}`;
    await runMonitor(pool, cfg, created.id, { force: true, capture: take });
  }
  assert.equal(
    (await pool.query("SELECT count(*) FROM fusion_events WHERE monitor_id=$1 AND status='changed'", [created.id])).rows[0].count,
    "0",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [created.id])).rows[0].count,
    "0",
  );
  title = "Updated Example Feature";
  hydration = "dynamic-real-change";
  await runMonitor(pool, cfg, created.id, { force: true, capture: take });
  assert.equal(
    (await pool.query("SELECT count(*) FROM fusion_events WHERE monitor_id=$1 AND status='changed'", [created.id])).rows[0].count,
    "1",
  );
  assert.equal(
    (await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [created.id])).rows[0].count,
    "1",
  );
  await pool.query("UPDATE fusion_monitors SET notification_enabled=false WHERE id=$1", [created.id]);
  state = "Closed";
  hydration = "dynamic-after-muted";
  await runMonitor(pool, cfg, created.id, { force: true, capture: take });
  const disabled = await pool.query("SELECT notification_state FROM fusion_events WHERE monitor_id=$1 AND status='changed' ORDER BY created_at DESC,id DESC LIMIT 1", [created.id]);
  assert.equal(disabled.rows[0].notification_state, "disabled");
  assert.equal(
    (await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [created.id])).rows[0].count,
    "1",
  );
});
test("browser extraction transition advances a legacy baseline once without notification or history loss", async () => {
  const created = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Legacy browser text fixture",
        url: "https://example.com/legacy-browser-text",
        kind: "browser",
        text_enabled: true,
        visual_enabled: false,
        notification_enabled: false,
        visual_threshold: "0.35",
        pixel_threshold: 0.1,
      })
      .expect(201)
  ).body;
  await runMonitor(pool, cfg, created.id, {
    force: true,
    capture: async () => ({ text: "legacy hydration payload", screenshot: null }),
  });
  const oldBaseline = (await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [created.id])).rows[0].baseline_id;
  await pool.query("UPDATE fusion_monitors SET browser_text_extraction_version=1 WHERE id=$1", [created.id]);
  await runMonitor(pool, cfg, created.id, {
    force: true,
    capture: async () => { throw Error("first visible-text transition failed token=synthetic"); },
  });
  const failedTransition = (await pool.query("SELECT browser_text_extraction_version,baseline_id FROM fusion_monitors WHERE id=$1", [created.id])).rows[0];
  assert.equal(failedTransition.browser_text_extraction_version, 1);
  assert.equal(failedTransition.baseline_id, oldBaseline);
  assert.equal((await pool.query("SELECT count(*) FROM fusion_events WHERE monitor_id=$1 AND status='extraction_transition'", [created.id])).rows[0].count, "0");
  assert.equal(await runMonitor(pool, cfg, created.id, {
    force: true,
    capture: async () => ({ text: "Visible page content", screenshot: null }),
  }), true);
  const transitioned = (await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [created.id])).rows[0];
  assert.equal(transitioned.browser_text_extraction_version, 2);
  assert.notEqual(transitioned.baseline_id, oldBaseline);
  assert.equal((await pool.query("SELECT count(*) FROM fusion_captures WHERE monitor_id=$1", [created.id])).rows[0].count, "2");
  const transition = await pool.query("SELECT status,notification_state FROM fusion_events WHERE monitor_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [created.id]);
  assert.deepEqual(transition.rows[0], { status: "extraction_transition", notification_state: "not_requested" });
  await runMonitor(pool, cfg, created.id, {
    force: true,
    capture: async () => ({ text: "Visible page content updated", screenshot: null }),
  });
  const changed = await pool.query("SELECT notification_state FROM fusion_events WHERE monitor_id=$1 AND status='changed'", [created.id]);
  assert.equal(changed.rows[0].notification_state, "disabled");
  assert.equal((await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [created.id])).rows[0].count, "0");
});
test("combined browser extraction transitions absorb visual changes without notifications", async () => {
  const create = async (name: string) => (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name,
        url: "https://example.com/combined-transition",
        kind: "browser",
        text_enabled: true,
        visual_enabled: true,
        notification_enabled: true,
        visual_threshold: "0.35",
        pixel_threshold: 0.1,
      })
      .expect(201)
  ).body;
  for (const [name, next] of [
    ["Combined visual transition", image(80)] as const,
    ["Combined dimensions transition", image(0, 120, 100)] as const,
  ]) {
    const created = await create(name);
    await runMonitor(pool, cfg, created.id, {
      force: true,
      capture: async () => ({ text: "legacy hydration", screenshot: image() }),
    });
    const old = (await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [created.id])).rows[0].baseline_id;
    await pool.query("UPDATE fusion_monitors SET browser_text_extraction_version=1 WHERE id=$1", [created.id]);
    await runMonitor(pool, cfg, created.id, {
      force: true,
      capture: async () => ({ text: "Visible page content", screenshot: next }),
      comparator: { compare: () => { throw Error("transition must not compare legacy visual baseline"); } },
    });
    const state = (await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [created.id])).rows[0];
    assert.equal(state.browser_text_extraction_version, 2);
    assert.notEqual(state.baseline_id, old);
    assert.equal(state.last_change_at, null);
    const event = (await pool.query("SELECT status,text_changed,visual_changed,dimension_changed,visual_percent,notification_state FROM fusion_events WHERE monitor_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [created.id])).rows[0];
    assert.deepEqual(event, {
      status: "extraction_transition",
      text_changed: false,
      visual_changed: false,
      dimension_changed: false,
      visual_percent: null,
      notification_state: "not_requested",
    });
    assert.equal((await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [created.id])).rows[0].count, "0");
  }
});
test("legacy browser monitor without a baseline advances directly to visible text v2", async () => {
  const created = (
    await ownerAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
      name: "Legacy no baseline", url: "https://example.com/no-baseline", kind: "browser",
      text_enabled: true, visual_enabled: false, notification_enabled: false,
    }).expect(201)
  ).body;
  await pool.query("UPDATE fusion_monitors SET browser_text_extraction_version=1 WHERE id=$1", [created.id]);
  await runMonitor(pool, cfg, created.id, {
    force: true, capture: async () => ({ text: "Visible initial content", screenshot: null }),
  });
  const state = (await pool.query("SELECT browser_text_extraction_version,baseline_id,last_change_at FROM fusion_monitors WHERE id=$1", [created.id])).rows[0];
  assert.equal(state.browser_text_extraction_version, 2);
  assert.ok(state.baseline_id);
  assert.equal(state.last_change_at, null);
  const event = (await pool.query("SELECT status FROM fusion_events WHERE monitor_id=$1", [created.id])).rows[0];
  assert.equal(event.status, "baseline");
});
test("controlled HTML and API monitoring preserve functionality with canonical JSON", async (t) => {
  const fixture = managedServer(t, (req, res) =>
    res.end(req.url === "/json" ? '{"z":1,"a":2}' : "<main>Hello</main>"),
  );
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async () => [{ address: "127.0.0.1", family: 4 }],
    (ip) => ip === "127.0.0.1",
    new Set([port]),
  );
  try {
    const m = {
      ...monitor,
      url: `http://fixture.test:${port}/json`,
      kind: "api",
      ignore_text: [],
      normalize_whitespace: false,
      ignore_case: false,
    };
    assert.equal(
      (await capture(m, cfg, policy)).text,
      '{\n  "a": 2,\n  "z": 1\n}',
    );
    assert.equal(
      (
        await capture(
          { ...m, kind: "html", url: `http://fixture.test:${port}` },
          cfg,
          policy,
        )
      ).text,
      "<main>Hello</main>",
    );
  } finally {
    await closeServer(fixture);
  }
});
test("retention keeps referenced historical screenshots and current baseline", async () => {
  await retainHistory(pool, cfg);
  const r = await pool.query(
    "SELECT baseline_id FROM fusion_monitors WHERE id=$1",
    [monitor.id],
  );
  assert.ok(
    (
      await pool.query("SELECT id FROM fusion_captures WHERE id=$1", [
        r.rows[0].baseline_id,
      ])
    ).rowCount,
  );
});
test("legacy migration preserves owner, historical references and NUMERIC decimals", async () => {
  const legacyName = "fusion_test_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE ${legacyName}`);
  const url = new URL(dbURL);
  url.pathname = "/" + legacyName;
  const legacy = makePool(url.href);
  try {
    await legacy.query(
      await readFile(
        new URL("../../db_script/changd.sql", import.meta.url),
        "utf8",
      ),
    );
    await legacy.query(
      "INSERT INTO users(user_id,email,password) VALUES('fixture-owner','legacy@example.com','synthetic')",
    );
    await legacy.query(
      "INSERT INTO jobs(job_name,user_id,url,job_type,diff_percent) VALUES('Legacy','fixture-owner','https://example.com',0,5)",
    );
    await legacy.query(
      "INSERT INTO history(job_id,change_percent,screenshot,source_screenshot) VALUES(1,1,'historical.png','baseline.png')",
    );
    // Reconstruct the applied Sprint 1.1 schema, then apply only the new migration 003.
    const firstSQL = await readFile(
      new URL("../../migrations/001_fusion.sql", import.meta.url),
      "utf8",
    );
    await legacy.query(firstSQL);
    await legacy.query(
      "CREATE TABLE fusion_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await legacy.query(
      "INSERT INTO fusion_migrations(name,checksum) VALUES($1,$2)",
      ["001_fusion.sql", createHash("sha256").update(firstSQL).digest("hex")],
    );
    const secondSQL = await readFile(
      new URL(
        "../../migrations/002_capture_modes_dimensions.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await legacy.query(secondSQL);
    await legacy.query(
      "INSERT INTO fusion_migrations(name,checksum) VALUES($1,$2)",
      [
        "002_capture_modes_dimensions.sql",
        createHash("sha256").update(secondSQL).digest("hex"),
      ],
    );
    const original = (await legacy.query("SELECT id FROM fusion_monitors"))
      .rows[0].id;
    const preservedCapture = randomUUID();
    await legacy.query(
      "INSERT INTO fusion_captures(id,monitor_id,text_content,screenshot) VALUES($1,$2,$3,$4)",
      [
        preservedCapture,
        original,
        "Preserved Sprint 1 baseline",
        randomUUID() + ".png",
      ],
    );
    await legacy.query(
      "UPDATE fusion_monitors SET baseline_id=$2,latest_capture_id=$2,last_percent=$3 WHERE id=$1",
      [original, preservedCapture, "0.35"],
    );
    await migrate(legacy);
    await migrate(legacy);
    const upgraded = (
      await legacy.query("SELECT * FROM fusion_monitors WHERE id=$1", [
        original,
      ])
    ).rows[0];
    assert.equal(upgraded.capture_mode, "viewport");
    assert.equal(upgraded.browser_text_extraction_version, 2);
    assert.deepEqual(upgraded.browser_steps, []);
    assert.equal(upgraded.monitor_state, "healthy");
    assert.equal(Number((await legacy.query("SELECT count(*) FROM fusion_migrations")).rows[0].count), expectedMigrationCount);
    assert.equal(upgraded.baseline_id, preservedCapture);
    assert.equal(upgraded.latest_capture_id, preservedCapture);
    assert.equal(upgraded.last_percent, "0.3500000000");
    const r = await legacy.query(
      "SELECT m.user_id,e.legacy_refs FROM fusion_monitors m JOIN fusion_events e ON e.monitor_id=m.id",
    );
    assert.equal(r.rows[0].user_id, "fixture-owner");
    assert.equal(r.rows[0].legacy_refs.source_screenshot, "baseline.png");
    await legacy.query("UPDATE history SET change_percent=$1", ["0.35"]);
    assert.equal(
      (await legacy.query("SELECT change_percent FROM history")).rows[0]
        .change_percent,
      "0.3500000000",
    );
  } finally {
    await legacy.end();
    await admin.query(`DROP DATABASE ${legacyName}`);
  }
});

test("dimension events persist explicit sizes, preserve both images, advance baseline once and notify without fake percentages", async () => {
  const m = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Dimension fixture",
        url: "https://example.com",
        text_enabled: true,
        visual_enabled: true,
        visual_threshold: "100",
        channel_ids: [channelId],
      })
      .expect(201)
  ).body;
  const take = (width: number, text: string) => async () => ({
    text,
    screenshot: image(0, width, 100),
  });
  await runMonitor(pool, cfg, m.id, {
    force: true,
    capture: take(100, "before"),
  });
  await runMonitor(pool, cfg, m.id, {
    force: true,
    capture: take(90, "after"),
  });
  const h = (await ownerAgent.get(`/api/v1/jobs/${m.id}/history`).expect(200))
    .body;
  const changed = h.find((e: any) => e.status === "changed");
  assert.equal(changed.dimension_changed, true);
  assert.equal(changed.visual_percent, null);
  assert.equal(changed.visual_changed, true);
  assert.equal(changed.text_changed, true);
  assert.equal(changed.diff_screenshot, null);
  assert.deepEqual(changed.before_dimensions, { width: 100, height: 100 });
  assert.deepEqual(changed.after_dimensions, { width: 90, height: 100 });
  await ownerAgent
    .get("/api/v1/screenshots/" + changed.before_image)
    .expect(200);
  await ownerAgent
    .get("/api/v1/screenshots/" + changed.after_image)
    .expect(200);
  const baseline = (await ownerAgent.get(`/api/v1/jobs/${m.id}`)).body
    .baseline_id;
  const delivered: any[] = [];
  await dispatch(pool, cfg, async (_p, _c, e) => {
    if (e.monitorId === m.id) delivered.push(e);
  });
  assert.equal(delivered.length, 1);
  const { summary, emailHTML } = await import("../../src/notifications.js");
  assert.match(summary(delivered[0]), /100×100 → 90×100/);
  assert.match(emailHTML(delivered[0]), /Pixel percentage unavailable/);
  assert.ok(!summary(delivered[0]).includes("100%"));
  await runMonitor(pool, cfg, m.id, {
    force: true,
    capture: take(90, "after"),
  });
  assert.equal(
    (await ownerAgent.get(`/api/v1/jobs/${m.id}`)).body.baseline_id,
    baseline,
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM fusion_outbox WHERE event_id=$1", [
        changed.id,
      ])
    ).rows[0].count,
    "1",
  );
});

test("HTTP status-only transitions advance history and notify independently of text direction", async () => {
  const monitor = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "HTTP status fixture",
        url: "https://example.com/status",
        monitor_http_error_pages: true,
        text_direction: "removed",
        channel_ids: [channelId],
      })
      .expect(201)
  ).body;
  const take = (http_status: number) => runMonitor(pool, cfg, monitor.id, {
    force: true,
    capture: async () => ({ text: "stable content", screenshot: null, http_status }),
  });
  await take(200);
  await take(403);
  await take(200);
  const history = (await ownerAgent.get(`/api/v1/jobs/${monitor.id}/history`).expect(200)).body;
  const changed = history.filter((event: any) => event.status === "changed");
  assert.equal(changed.length, 2);
  assert.deepEqual(changed.map((event: any) => event.http_status).sort(), [200, 403]);
  assert.ok(changed.every((event: any) => event.http_status_changed && event.text_changed === false));
  assert.ok(changed.some((event: any) => event.before_http_status === 200 && event.http_status === 403));
  assert.ok(changed.some((event: any) => event.before_http_status === 403 && event.http_status === 200));
  assert.ok(changed.every((event: any) => event.notification_state !== "direction_filtered"));
  assert.equal((await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [monitor.id])).rows[0].count, "2");
  const stored = (await ownerAgent.get(`/api/v1/jobs/${monitor.id}`).expect(200)).body;
  assert.equal(stored.last_http_status, 200);
});

test("browser smoke: sign in, monitor history, decimal display, image comparison and mobile layout", async (t) => {
  const { chromium } = await import("playwright");
  const { readFile } = await import("node:fs/promises");
  // The browser smoke generates many authenticated synthetic requests. Give it
  // an independent production-equivalent limiter so it cannot affect API tests
  // that deliberately assert their own authorization outcomes later in this file.
  const smokeApp = createApp(
    pool,
    cfg,
    new EgressPolicy(async () => [{ address: "8.8.8.8", family: 4 }]),
    { telegramValidate: async () => ({ first_name: "Fixture Bot", username: "fixture_bot" }) },
  );
  const apiServer = smokeApp.listen(0, "127.0.0.1");
  t.after(() => closeServer(apiServer));
  await new Promise<void>((r) => apiServer.once("listening", r));
  const apiPort = (apiServer.address() as AddressInfo).port;
  const ui = managedServer(t, async (req, res) => {
    if (req.url?.startsWith("/api/")) {
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: apiPort,
          path: req.url,
          method: req.method,
          agent: false,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode!, r.headers);
          r.pipe(res);
        },
      );
      upstream.on("error", () => res.end());
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    const pathName = req.url?.split("?")[0];
    const file =
      pathName?.startsWith("/assets/") || pathName === "/allmy-theme-init.js"
        ? pathName
        : "/index.html";
    try {
      const body = await readFile(
        new URL("../../../frontend/dist" + file, import.meta.url),
      );
      res.setHeader(
        "Content-Type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  t.after(() => closeServer(ui));
  await listenServer(ui);
  const origin = "http://127.0.0.1:" + (ui.address() as AddressInfo).port;
  const oldURL = cfg.PUBLIC_URL;
  cfg.PUBLIC_URL = origin;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      chromiumSandbox: true,
      executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH,
      timeout: 15000,
    });
    // Exercise the real Ant Design modal at the narrowest supported viewport
    // before opening the rate-limited dashboard fixture. This page uses only
    // synthetic API responses; real owner verification and step-up are covered
    // by the dedicated API integration test below.
    const layoutPage = await browser.newPage({ viewport: { width: 320, height: 720 } });
    await layoutPage.route("**/api/v1/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.endsWith("/users/me")
        ? { user_id: "00000000-0000-4000-8000-000000000001", firstname: "Fixture", lastname: "Owner", email: "owner@example.com", user_type: 0, public_access: false }
        : pathname.endsWith("/jobs") || pathname.endsWith("/notifications") ? []
        : pathname.endsWith("/account/public-access") ? { public_enabled: false }
        : { ok: true };
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await layoutPage.goto(origin);
    await layoutPage.getByRole("button", { name: "Open account menu", exact: true }).click();
    await layoutPage.getByRole("button", { name: "Account security", exact: true }).click();
    await layoutPage.getByLabel("Email", { exact: true }).fill("owner@example.com");
    await layoutPage.getByLabel("Password", { exact: true }).fill(password);
    await layoutPage.getByRole("button", { name: "Verify account", exact: true }).click();
    const publicControl = layoutPage.getByRole("region", { name: "Public Access setting" });
    await publicControl.waitFor();
    await publicControl.getByRole("button", { name: "Enable public access", exact: true }).click();
    const publicDialog = layoutPage.getByRole("dialog", { name: "Enable public access?", exact: true });
    await publicDialog.waitFor();
    const publicBounds = await publicDialog.boundingBox();
    assert.ok(publicBounds && publicBounds.x >= 0 && publicBounds.x + publicBounds.width <= 320, "Public Access confirmation fits a 320px viewport");
    for (const action of ["Cancel", "Enable public access"]) {
      const button = publicDialog.getByRole("button", { name: action, exact: true });
      await button.waitFor();
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 720, `${action} remains visible in the mobile confirmation`);
    }
    const publicOverflow = await layoutPage.evaluate(() => Array.from(document.querySelectorAll("*"))
      .map((element) => ({
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        width: element.getBoundingClientRect().width,
      }))
      .filter((element) => (element.left < -1 || element.right > window.innerWidth + 1) && element.width > 0)
      .slice(0, 12));
    assert.deepEqual(publicOverflow, [], `Public Access confirmation must not cause horizontal overflow: ${JSON.stringify(publicOverflow)}`);
    await layoutPage.keyboard.press("Escape");
    await publicDialog.waitFor({ state: "hidden" });
    await publicControl.getByRole("button", { name: "Enable public access", exact: true }).click();
    await publicDialog.waitFor();
    await publicDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await publicDialog.waitFor({ state: "hidden" });
    await layoutPage.close();
    const page = await browser.newPage();
    // A controlled completed preview makes the documentation screenshot
    // deterministic without contacting a production or external website.
    const regionPreviewBodies: any[] = [];
    await page.route("**/api/v1/region-preview", async (route) => {
      const requestBody = route.request().postDataJSON();
      regionPreviewBodies.push(requestBody);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          session_id: requestBody.mode === "area" ? undefined : "00000000-0000-4000-8000-000000000099",
          image: previewImage().toString("base64"),
          width: 1280,
          height: 900,
          selection: requestBody.mode === "area" ? null : { selector: "#fixture-price", x: 160, y: 160, width: 360, height: 80 },
        }),
      });
    });
    const errors: string[] = [];
    let jobsRequests = 0, notificationRequests = 0;
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/v1/jobs") jobsRequests++;
      if (pathname === "/api/v1/notifications") notificationRequests++;
    });
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("UI fixture runtime error:", e.message);
    });
    page.setDefaultTimeout(8000);
    await page.goto(origin);
    await page.getByLabel("Email", { exact: true }).fill("owner@example.com");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const themeSwitch = page.getByRole("switch", { name: /Switch to .* theme/ });
    await themeSwitch.waitFor();
    const initialTheme = await page.locator("html").getAttribute("data-theme");
    await themeSwitch.click();
    assert.notEqual(await page.locator("html").getAttribute("data-theme"), initialTheme);
    assert.equal(await page.locator("html").getAttribute("data-theme-mode"), await page.locator("html").getAttribute("data-theme"));
    await page.getByRole("button", { name: "Use automatic system theme" }).click();
    assert.equal(await page.locator("html").getAttribute("data-theme-mode"), "system");
    const output = process.env.UI_SCREENSHOT_DIR ?? root;
    await mkdir(output, { recursive: true });
    await page
      .getByRole("searchbox", { name: "Search monitors" })
      .fill("Hybrid fixture");
    await page
      .getByRole("button", { name: "Hybrid fixture", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Dimension fixture", exact: true })
        .count(),
      0,
    );
    const actionsMenu = page.getByRole("button", { name: "Actions for Hybrid fixture" });
    await actionsMenu.waitFor();
    assert.ok(await actionsMenu.isVisible(), "desktop actions must remain visible");
    const actionBounds = await actionsMenu.boundingBox();
    assert.ok(
      actionBounds && actionBounds.x + actionBounds.width <= 1278,
      "desktop actions must not be clipped at the table edge",
    );
    await actionsMenu.click();
    await page.getByText("Delete", { exact: true }).waitFor();
    const search = page.getByRole("searchbox", { name: "Search monitors" });
    await search.focus();
    const jobsBeforePolling = jobsRequests;
    const notificationsBeforePolling = notificationRequests;
    await pool.query("UPDATE fusion_monitors SET monitor_state='changed', last_run=now() WHERE id=$1", [monitor.id]);
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".monitor-table-card .ant-tag")].some(
          (tag) => tag.textContent?.trim() === "changed",
        ) && !document.querySelector(".monitor-table-card .ant-spin-spinning"),
      undefined,
      { timeout: 19000 },
    );
    assert.ok(jobsRequests > jobsBeforePolling, "the 15 second poll refreshes monitor data");
    assert.equal(notificationRequests, notificationsBeforePolling, "silent monitor polling does not refetch notification channels");
    assert.equal(await search.inputValue(), "Hybrid fixture", "search text survives silent polling");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Search monitors", "focused input survives silent polling");
    assert.ok(await page.getByText("Delete", { exact: true }).isVisible(), "an open actions menu remains open during silent polling");
    await actionsMenu.click();
    await page.getByText("Delete", { exact: true }).waitFor({ state: "hidden" });
    await search.fill("");
    await page.screenshot({ path: path.join(output, "dashboard-desktop.png") });
    await themeSwitch.click();
    await page.waitForFunction(() => {
      if (document.documentElement.dataset.theme !== "dark") return false;
      const cell = document.querySelector(".monitor-table-card .ant-table-tbody td");
      const item = document.querySelector(".ant-layout-sider .ant-menu-item:not(.ant-menu-item-selected) .ant-menu-title-content");
      if (!cell || !item) return false;
      const cellColor = getComputedStyle(cell).backgroundColor;
      const itemColor = getComputedStyle(item).color;
      return cellColor === "rgb(17, 30, 47)" && itemColor === "rgb(198, 212, 228)";
    });
    await page.waitForTimeout(1000);
    assert.equal(
      await page.locator(".monitor-table-card .ant-table-tbody td").first().evaluate((cell) => getComputedStyle(cell).backgroundColor),
      "rgb(17, 30, 47)",
      "the settled dark table must keep its semantic dark surface",
    );
    assert.equal(
      await page.locator(".ant-layout-sider .ant-menu-item:not(.ant-menu-item-selected) .ant-menu-title-content").first().evaluate((item) => getComputedStyle(item).color),
      "rgb(198, 212, 228)",
      "dark sidebar navigation labels must remain readable",
    );
    assert.equal(
      await page.evaluate(() => {
        const target = document.elementFromPoint(600, 350)?.closest("td, th, .ant-table-cell");
        return target ? getComputedStyle(target).backgroundColor : "missing";
      }),
      "rgb(17, 30, 47)",
      "the visible dark table surface must not retain a light token",
    );
    await page.screenshot({ path: path.join(output, "dashboard-desktop-dark.png") });
    await themeSwitch.click();
    await page.getByText("Settings", { exact: true }).first().click();
    await page.getByRole("heading", { name: "Settings" }).waitFor();
    const applicationMetadata = page.locator(".application-metadata");
    await applicationMetadata.waitFor();
    const waitForApplicationLayout = async (width: number, theme: "light" | "dark") => {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
      await page.evaluate(async () => {
        await document.fonts.ready.catch(() => undefined);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
    };
    for (const theme of ["light", "dark"] as const) {
      if (await page.locator("html").getAttribute("data-theme") !== theme) {
        await page.getByRole("banner").locator("[data-allmy-theme-switch]").click();
        await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
      }
      for (const width of [320, 360, 375, 390, 393, 430, 768, 1280]) {
        await waitForApplicationLayout(width, theme);
      const layout = await applicationMetadata.evaluate((card) => {
        const content = card.querySelector(".ant-card-body") ?? card;
        const contentBox = content.getBoundingClientRect();
        const values = Array.from(card.querySelectorAll(".application-metadata-list dd"))
          .map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, width: box.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
          })
          .filter((box) => box.width > 0);
        const branch = card.querySelector(".application-metadata-value:not(a)");
        const tokens = Array.from(card.querySelectorAll(".application-metadata-token")).map((element) => ({
          text: element.textContent,
          lines: element.getClientRects().length,
          width: element.getBoundingClientRect().width,
          wordBreak: getComputedStyle(element).wordBreak,
          whiteSpace: getComputedStyle(element).whiteSpace,
        }));
        return {
          contentBox: { left: contentBox.left, right: contentBox.right },
          values,
          branch: branch ? { scrollWidth: branch.scrollWidth, clientWidth: branch.clientWidth } : null,
          tokens,
          scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          viewportWidth: window.innerWidth,
        };
      });
        assert.ok(layout.scrollWidth <= layout.viewportWidth, `Application metadata does not overflow at ${width}px in ${theme} theme`);
        assert.ok(layout.values.every((value) => value.left >= layout.contentBox.left - 1 && value.right <= layout.contentBox.right + 1), `Application metadata values fit their card at ${width}px in ${theme} theme`);
        assert.ok(layout.values.every((value) => value.scrollWidth <= value.clientWidth + 1), `Application metadata values wrap without clipping at ${width}px in ${theme} theme`);
        assert.ok(!layout.branch || layout.branch.scrollWidth <= layout.branch.clientWidth + 1, `Application branch remains readable at ${width}px in ${theme} theme`);
        assert.ok(layout.tokens.every((token) => token.lines === 1 && token.width > 20 && token.wordBreak === "normal" && token.whiteSpace === "nowrap"), `Application metadata tokens do not split character-by-character at ${width}px in ${theme} theme`);
      }
    }
    const commitLink = page.getByRole("link", { name: /^Commit [0-9a-f]{40}$/i });
    if (await commitLink.count())
      assert.match(await commitLink.getAttribute("href") ?? "", /^https:\/\/github\.com\/mkaand\/changd-fusion\/commit\/[0-9a-f]{40}$/i);
    else
      assert.ok(await applicationMetadata.getByText("Unavailable", { exact: true }).count(), "missing build metadata has a safe fallback");
    const sourcePr = page.getByRole("link", { name: /^#\d+$/ });
    if (await sourcePr.count())
      assert.match(await sourcePr.getAttribute("href") ?? "", /^https:\/\/github\.com\/mkaand\/changd-fusion\/pull\/\d+$/);
    else
      assert.ok(await applicationMetadata.getByText("Unavailable", { exact: true }).count(), "missing source PR metadata has a safe fallback");
    if (await page.locator("html").getAttribute("data-theme") !== "light") {
      await page.getByRole("banner").locator("[data-allmy-theme-switch]").click();
      await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByText("Notifications", { exact: true }).first().click();
    await page.getByRole("heading", { name: "Notification channels" }).waitFor();
    await page.screenshot({ path: path.join(output, "settings-notifications.png") });
    await page.getByText("Timeline", { exact: true }).first().click();
    await page.getByRole("heading", { name: "Timeline" }).waitFor();
    await page.getByLabel("Filter timeline by status").waitFor();
    await page.getByText("Analytics", { exact: true }).first().click();
    await page.getByRole("heading", { name: "Analytics" }).waitFor();
    await page.getByText("Successful captures", { exact: true }).waitFor();
    assert.ok(await page.getByRole("img", { name: "Daily capture event trend" }).count());
    await page.getByText("Monitors", { exact: true }).first().click();
    await page.getByRole("searchbox", { name: "Search monitors" }).fill("Hybrid fixture");
    await page
      .getByRole("button", { name: "Hybrid fixture", exact: true })
      .click();
    await page.getByText("Monitoring history", { exact: true }).waitFor();
    await page.getByText("Visual: 0.35%", { exact: true }).first().waitFor();
    assert.ok(await page.getByAltText("Before capture").count());
    assert.ok(await page.getByAltText("After capture").count());
    const slider = page
      .getByRole("slider", { name: "Drag to compare before and after" })
      .first();
    assert.equal(await page.locator(".ant-slider").count(), 0, "the on-image comparison is the only slider control");
    await slider.focus();
    await slider.press("ArrowRight");
    assert.equal(await slider.getAttribute("aria-valuenow"), "51");
    await slider.press("End");
    assert.equal(await slider.getAttribute("aria-valuenow"), "100");
    const comparisonImage = slider;
    await comparisonImage.scrollIntoViewIfNeeded();
    const comparisonBounds = await comparisonImage.boundingBox();
    assert.ok(comparisonBounds);
    const comparisonY = comparisonBounds.y + Math.min(80, comparisonBounds.height / 2);
    await page.mouse.move(comparisonBounds.x + comparisonBounds.width / 2, comparisonY);
    await page.mouse.down();
    await page.mouse.move(comparisonBounds.x + comparisonBounds.width * .25, comparisonY, { steps: 4 });
    await page.mouse.up();
    assert.equal(await slider.getAttribute("aria-valuenow"), "25", "mouse drag moves the on-image divider");
    const touchSession = await page.context().newCDPSession(page);
    try {
      await touchSession.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: comparisonBounds.x + comparisonBounds.width / 2, y: comparisonY }] });
      await touchSession.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: comparisonBounds.x + comparisonBounds.width * .75, y: comparisonY }] });
      await touchSession.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      assert.equal(await slider.getAttribute("aria-valuenow"), "75", "touch drag moves the same divider");
      assert.equal(await comparisonImage.locator(".after").evaluate(el => getComputedStyle(el).clipPath), "inset(0px 0px 0px 75%)");
    } finally { await touchSession.detach(); }
    // Restore the documented composition after exercising both input paths.
    await slider.focus();
    await slider.press("Home");
    for (let value = 0; value < 51; value++) await slider.press("ArrowRight");
    await page.screenshot({ path: path.join(output, "history-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(
      () =>
        !!document.querySelector(".navigation-toggle") &&
        document.documentElement.scrollWidth <= window.innerWidth,
    );
    assert.ok(await themeSwitch.isVisible(), "AllMy theme controls stay visible on mobile");
    const overflow = await page.evaluate(() =>
      Array.from(document.querySelectorAll("*"))
        .map((el) => ({
          tag: el.tagName,
          className: typeof el.className === "string" ? el.className : "",
          right: el.getBoundingClientRect().right,
          width: el.getBoundingClientRect().width,
        }))
        .filter((el) => el.right > window.innerWidth + 1 && el.width > 0)
        .slice(0, 12),
    );
    if (overflow.length)
      console.error("Mobile fixture overflow:", JSON.stringify(overflow));
    await page.screenshot({ path: path.join(output, "history-mobile.png") });
    const historySpacing = await page.locator(".monitor-history").evaluate((history) => ({
      top: Number.parseFloat(getComputedStyle(history).marginTop),
      content: Array.from(history.querySelectorAll(".event .ant-card-body > .ant-alert, .event .ant-card-body > .text-diff"))
        .map((element) => Number.parseFloat(getComputedStyle(element).marginTop)),
    }));
    assert.equal(historySpacing.top, 16, "Monitoring History keeps a 16px gap from preceding metadata");
    assert.ok(historySpacing.content.every((margin) => margin >= 16), "history information and value blocks keep at least 16px top spacing");
    assert.ok(
      await page
        .getByRole("button", { name: "Check now", exact: true })
        .isVisible(),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      "Mobile page must not overflow horizontally",
    );
    await page.getByRole("button", { name: "← Monitors", exact: true }).click();
    await page.locator(".monitor-card").first().waitFor();
    assert.equal(await page.locator(".ant-table").count(), 0);
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const actions = page.locator(".monitor-card-actions").first();
      const details = actions.getByRole("button", { name: "Details", exact: true });
      const checkNow = actions.getByRole("button", { name: "Check now", exact: true });
      const edit = actions.getByRole("button", { name: "Edit", exact: true });
      const [detailsBounds, checkBounds, editBounds] = await Promise.all([details.boundingBox(), checkNow.boundingBox(), edit.boundingBox()]);
      assert.ok(detailsBounds && checkBounds && editBounds, "mobile monitor actions have measurable bounds");
      assert.ok(Math.abs(detailsBounds.y - editBounds.y) < 2, `Details and Edit share the first row at ${width}px`);
      const firstRowBottom = Math.max(detailsBounds.y + detailsBounds.height, editBounds.y + editBounds.height);
      assert.ok(Math.abs(checkBounds.y - firstRowBottom - 12) < 1, `Check now keeps a 12px row gap at ${width}px`);
      assert.ok(checkBounds.width >= detailsBounds.width + editBounds.width - 4, `Check now spans both columns at ${width}px`);
      assert.ok(checkBounds.x >= 0 && checkBounds.x + checkBounds.width <= width, `monitor actions fit ${width}px without overflow`);
      assert.ok(detailsBounds.height >= 44 && editBounds.height >= 44 && checkBounds.height >= 44, `monitor actions keep 44px targets at ${width}px`);
    }
    for (const width of [320, 375, 390, 430, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "Open navigation" }).waitFor();
      assert.ok(await page.locator(".monitor-card").count(), `card dashboard at ${width}px`);
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `dashboard must not overflow at ${width}px`,
      );
    }
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await page.locator(".monitor-table-card .ant-table").waitFor();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `desktop dashboard must not overflow at ${width}px`,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // The monitor-list search intentionally survives navigation and polling.
    // Clear the earlier Hybrid fixture filter before selecting this fixture.
    await page.getByRole("searchbox", { name: "Search monitors" }).fill("");
    await page.getByRole("button", { name: "Dimension fixture", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Dimension fixture", exact: true })
      .click();
    await page
      .getByText("Screenshot dimensions changed", { exact: true })
      .waitFor();
    assert.equal(await page.getByRole("slider").count(), 1);
    await page
      .locator(".event")
      .filter({
        has: page.getByText("Screenshot dimensions changed", { exact: true }),
      })
      .screenshot({ path: path.join(output, "dimensions-mobile.png") });
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const mobileEditor = page.locator('section[aria-label="Edit monitor"]');
    await mobileEditor.waitFor();
    assert.equal(await page.getByLabel("Screenshot capture mode", { exact: true }).count(), 0, "advanced controls start collapsed");
    await mobileEditor.locator(".monitor-editor-form").waitFor();
    await mobileEditor.getByRole("button", { name: "Save monitor", exact: true }).waitFor();
    const editorBounds = await mobileEditor.boundingBox();
    assert.ok(editorBounds && editorBounds.width <= 390, "mobile editor fits the Safari-sized viewport");
    await page.getByText("Advanced settings", { exact: true }).click();
    await page.getByLabel("Screenshot capture mode", { exact: true }).waitFor();
    const textControls = page.getByRole("region", { name: "Text monitoring settings" });
    await textControls.waitFor();
    assert.equal(await page.getByLabel("Notification direction", { exact: true }).count(), 1, "the editor renders one shared notification direction control");
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = await textControls.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `text monitoring controls fit ${width}px`);
      const overflowing = await textControls.evaluate((controls) => Array.from(controls.querySelectorAll("*"))
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.width > 0 && (bounds.left < -1 || bounds.right > window.innerWidth + 1);
        })
        .map((element) => ({ tag: element.tagName, className: typeof element.className === "string" ? element.className : "" })));
      assert.deepEqual(overflowing, [], `text monitoring controls must not overflow at ${width}px`);
    }
    const chooseTextSource = async (label: "Direct browser content (default)" | "Jina Reader — sends the URL to a third party") => {
      await page.getByLabel("Text content source", { exact: true }).click();
      await page.getByText(label, { exact: true }).last().click();
      await page.waitForFunction(() => Array.from(document.querySelectorAll(".ant-select-dropdown"))
        .every((dropdown) => dropdown.classList.contains("ant-select-dropdown-hidden") || dropdown.getBoundingClientRect().width === 0));
    };
    const chooseTextMode = async (label: "Full Text Changes" | "Selected Text / Value" | "Keyword Presence") => {
      await page.getByText(label, { exact: true }).last().click();
    };
    const assertTextControlBounds = async (source: "direct" | "jina", mode: string, width: number, dark: boolean) => {
      const layout = await textControls.evaluate((section) => {
        const form = section.closest(".monitor-editor-form");
        if (!form) throw new Error("mobile monitor form not found");
        const formBox = form.getBoundingClientRect();
        const formStyle = getComputedStyle(form);
        const left = formBox.left + Number.parseFloat(formStyle.paddingLeft);
        const right = formBox.right - Number.parseFloat(formStyle.paddingRight);
        const controls = Array.from(section.querySelectorAll(".ant-radio-button-wrapper, .ant-select, input.ant-input:not(.ant-select-selection-search-input), .ant-form-item-extra, .text-monitoring-mode-help, .jina-reader-notice"))
          .map((element) => {
            const box = element.getBoundingClientRect();
            return { className: typeof element.className === "string" ? element.className : "", height: box.height, left: box.left, right: box.right, top: box.top, width: box.width };
          })
          .filter((box) => box.width > 0);
        return { controls, left, right };
      });
      const outsideControls = layout.controls.filter((control) => control.left < layout.left - 1 || control.right > layout.right + 1);
      assert.ok(outsideControls.length === 0, `${source} ${mode} controls stay within the form content box at ${width}px in ${dark ? "dark" : "light"} mode: ${JSON.stringify({ bounds: { left: layout.left, right: layout.right }, outsideControls })}`);
      const buttons = layout.controls.filter((control) => control.className.includes("ant-radio-button-wrapper"));
      assert.equal(buttons.length, source === "jina" ? 3 : 2, `${source} exposes the expected text-monitoring modes`);
      assert.ok(buttons.every((button) => button.height >= 44), `${source} text-monitoring buttons keep 44px touch targets`);
      assert.ok(buttons.every((button) => Math.abs(button.width - buttons[0].width) < 1), `${source} text-monitoring buttons have equal widths`);
      if (source === "jina" && width <= 430) assert.ok(buttons.every((button, index) => index === 0 || button.top >= buttons[index - 1].top + buttons[index - 1].height), `Jina Reader modes stack vertically at ${width}px`);
      const viewport = await page.evaluate(() => {
        const overflowing = Array.from(document.querySelectorAll("*")).flatMap((element) => {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || (box.left >= -1 && box.right <= window.innerWidth + 1)) return [];
          const style = getComputedStyle(element);
          return [{ className: typeof element.className === "string" ? element.className : "", left: box.left, maxWidth: style.maxWidth, minWidth: style.minWidth, right: box.right, tag: element.tagName, width: box.width }];
        });
        return { overflowing, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth };
      });
      assert.ok(viewport.scrollWidth <= viewport.viewportWidth, `${source} ${mode} does not create horizontal viewport overflow at ${width}px: ${JSON.stringify(viewport)}`);
    };
    for (const dark of [false, true]) {
      if ((await page.locator("html").getAttribute("data-theme")) === "dark" !== dark) {
        await themeSwitch.click();
        await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, dark ? "dark" : "light");
      }
      for (const [source, modes] of [["direct", ["Full Text Changes", "Keyword Presence"]], ["jina", ["Full Text Changes", "Selected Text / Value", "Keyword Presence"]]] as const) {
        await chooseTextSource(source === "jina" ? "Jina Reader — sends the URL to a third party" : "Direct browser content (default)");
        for (const mode of modes) {
          await chooseTextMode(mode);
          if (mode === "Keyword Presence") await page.getByLabel("Keyword", { exact: true }).waitFor();
          for (const width of [320, 375, 390, 430, 768]) {
            await page.setViewportSize({ width, height: 844 });
            await assertTextControlBounds(source, mode, width, dark);
          }
        }
      }
    }
    await chooseTextSource("Direct browser content (default)");
    await page.getByText("Keyword Presence", { exact: true }).click();
    await page.getByLabel("Keyword", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Select text from preview", exact: true }).count(), 0, "Keyword Presence does not show the Text Picker action");
    assert.equal(await page.getByLabel("Notification direction", { exact: true }).count(), 1, "Keyword Presence reuses the shared notification direction control");
    await page.setViewportSize({ width: 390, height: 1400 });
    await textControls.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(output, "capture-settings-mobile.png"),
    });
    await page.getByText("Full Text Changes", { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const captureMode = page.getByLabel("Screenshot capture mode", { exact: true });
    await captureMode.click();
    await page.getByText("Selected element / region", { exact: true }).last().click();
    await page.getByRole("button", { name: "Select region visually", exact: true }).waitFor();
    const urlBeforePicker = await page.getByLabel("URL", { exact: true }).inputValue();
    await page.getByRole("button", { name: "Select region visually", exact: true }).click();
    const picker = page.locator('section[aria-label="Select screenshot region"]');
    await picker.waitFor();
    const preview = picker.getByAltText("Secure monitor preview");
    await preview.waitFor();
    await picker.getByRole("button", { name: "Zoom in" }).click();
    assert.equal(await picker.getByLabel("Current zoom").textContent(), "125%");
    let previewBounds = await preview.boundingBox();
    assert.ok(previewBounds);
    const clickX = previewBounds.x + previewBounds.width * 0.3;
    const clickY = previewBounds.y + previewBounds.height * 0.3;
    const requestsBeforeClick = regionPreviewBodies.length;
    await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes("/api/v1/region-preview") && Boolean(candidate.request().postDataJSON()?.point)),
      page.mouse.click(clickX, clickY),
    ]);
    assert.equal(regionPreviewBodies.length, requestsBeforeClick + 1, "a captured mouse click resolves exactly one selection request");
    assert.ok(Math.abs(regionPreviewBodies.at(-1).point.x - 384) <= 1, "scaled mouse X maps to the original 1280px preview");
    assert.ok(Math.abs(regionPreviewBodies.at(-1).point.y - 270) <= 1, "scaled mouse Y maps to the original 900px preview");
    await picker.locator(".region-preview-highlight").waitFor();
    const highlightBounds = await picker.locator(".region-preview-highlight").boundingBox();
    previewBounds = await preview.boundingBox();
    assert.ok(highlightBounds && previewBounds);
    assert.ok(Math.abs((highlightBounds.x - previewBounds.x) / previewBounds.width - 160 / 1280) < 0.01, "highlight X remains aligned after zoom");
    assert.ok(Math.abs((highlightBounds.y - previewBounds.y) / previewBounds.height - 160 / 900) < 0.01, "highlight Y remains aligned after zoom");

    const canvasBounds = await picker.locator(".region-preview-canvas").boundingBox();
    assert.ok(canvasBounds);
    const dragRequests = regionPreviewBodies.length;
    await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.7, canvasBounds.y + canvasBounds.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(canvasBounds.x + canvasBounds.width * 0.35, canvasBounds.y + canvasBounds.height * 0.35, { steps: 4 });
    await page.mouse.up();
    assert.equal(regionPreviewBodies.length, dragRequests, "mouse panning does not select a region");

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
    previewBounds = await preview.boundingBox();
    assert.ok(previewBounds);
    const touchX = Math.max(canvasBounds.x + 20, Math.min(canvasBounds.x + canvasBounds.width - 20, previewBounds.x + previewBounds.width * 0.55));
    const touchY = Math.max(canvasBounds.y + 20, Math.min(canvasBounds.y + canvasBounds.height - 20, previewBounds.y + previewBounds.height * 0.45));
    const touchRequests = regionPreviewBodies.length;
    await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes("/api/v1/region-preview") && Boolean(candidate.request().postDataJSON()?.point)),
      (async () => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      })(),
    ]);
    assert.equal(regionPreviewBodies.length, touchRequests + 1, "a real Chromium touch tap resolves exactly one selection request");
    const zoomBeforePinch = await picker.getByLabel("Current zoom").textContent();
    const pinchRequests = regionPreviewBodies.length;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { x: touchX - 25, y: touchY, id: 1, radiusX: 1, radiusY: 1, force: 1 },
      { x: touchX + 25, y: touchY, id: 2, radiusX: 1, radiusY: 1, force: 1 },
    ] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: touchX - 55, y: touchY, id: 1, radiusX: 1, radiusY: 1, force: 1 },
      { x: touchX + 55, y: touchY, id: 2, radiusX: 1, radiusY: 1, force: 1 },
    ] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction((previous) => document.querySelector('[aria-label="Current zoom"]')?.textContent !== previous, zoomBeforePinch);
    assert.equal(regionPreviewBodies.length, pinchRequests, "pinch zoom does not select a region");
    await page.screenshot({ path: path.join(output, "region-picker-mobile.png") });
    await page.getByRole("button", { name: "← Back", exact: true }).click();
    await mobileEditor.waitFor();
    assert.equal(await page.getByLabel("URL", { exact: true }).inputValue(), urlBeforePicker, "Back preserves unsaved editor values");
    await page.getByText("Advanced settings", { exact: true }).waitFor();
    await page.getByLabel("Screenshot capture mode", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Select region visually", exact: true }).waitFor();
    await page.getByLabel("Screenshot region selector", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Add browser step", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add browser step", exact: true })
      .click();
    await page.getByRole("button", { name: "Move step 2 up" }).click();
    await page.getByRole("button", { name: "Remove step 2" }).click();
    await page.locator('section[aria-label="Browser steps"]').screenshot({
      path: path.join(output, "browser-steps-mobile.png"),
    });
    await page.getByRole("button", { name: "Remove step 1" }).click();
    await captureMode.click();
    await page.getByText("Selected area", { exact: true }).last().click();
    await page.getByRole("button", { name: "Select area visually", exact: true }).click();
    const areaPicker = page.locator('section[aria-label="Select screenshot area"]');
    await areaPicker.waitFor();
    const areaPreview = areaPicker.getByAltText("Secure selected area preview");
    await areaPreview.waitFor();
    assert.equal(regionPreviewBodies.at(-1).mode, "area");
    for (const selectedTheme of ["light", "dark"] as const) {
      if (await page.locator("html").getAttribute("data-theme") !== selectedTheme) {
        await themeSwitch.click();
        await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, selectedTheme);
      }
      for (const width of [320, 390, 430, 768]) {
        await page.setViewportSize({ width, height: 844 });
        const bounds = await areaPicker.locator(".mobile-region-picker-body").boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `Selected area picker fits ${width}px in ${selectedTheme} mode`);
        assert.ok(await areaPicker.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Selected area picker has no horizontal overflow at ${width}px in ${selectedTheme} mode`);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const areaBounds = await areaPreview.boundingBox();
    assert.ok(areaBounds);
    await page.mouse.move(areaBounds.x + areaBounds.width * .1, areaBounds.y + areaBounds.height * .1);
    await page.mouse.down();
    await page.mouse.move(areaBounds.x + areaBounds.width * .35, areaBounds.y + areaBounds.height * .3, { steps: 5 });
    await page.mouse.up();
    assert.equal(await areaPicker.getByText("320 × 180 px", { exact: true }).count(), 1, "mouse drag stores intrinsic 1280x900 coordinates");
    const areaBox = areaPicker.locator(".selected-area-box");
    await areaBox.waitFor();
    const handleBounds = await areaPicker.locator(".selected-area-handle").first().boundingBox();
    assert.ok(handleBounds && handleBounds.width >= 28 && handleBounds.height >= 28, "mobile resize handles remain touch sized");
    const selectedBeforePinch = await areaPicker.getByLabel("Selected area width").inputValue();
    const areaCanvas = await areaPicker.locator(".selected-area-canvas").boundingBox();
    assert.ok(areaCanvas);
    const areaTouchX = areaCanvas.x + areaCanvas.width / 2, areaTouchY = areaCanvas.y + areaCanvas.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
      { x: areaTouchX - 25, y: areaTouchY, id: 1, radiusX: 1, radiusY: 1, force: 1 },
      { x: areaTouchX + 25, y: areaTouchY, id: 2, radiusX: 1, radiusY: 1, force: 1 },
    ] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: areaTouchX - 55, y: areaTouchY, id: 1, radiusX: 1, radiusY: 1, force: 1 },
      { x: areaTouchX + 55, y: areaTouchY, id: 2, radiusX: 1, radiusY: 1, force: 1 },
    ] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(await areaPicker.getByLabel("Selected area width").inputValue(), selectedBeforePinch, "pinch zoom does not redraw the selected area");
    await areaPicker.getByRole("button", { name: "Apply selected area", exact: true }).click();
    await mobileEditor.waitFor();
    await page.getByRole("button", { name: "Save monitor", exact: true }).click();
    await page.getByRole("button", { name: "Dimension fixture", exact: true }).waitFor();
    const savedArea = (await pool.query("SELECT id,capture_mode,capture_area FROM fusion_monitors WHERE name='Dimension fixture'")).rows[0];
    assert.equal(savedArea.capture_mode, "selected_area");
    assert.deepEqual(savedArea.capture_area, { x: 128, y: 90, width: 320, height: 180 });
    // Saving the selected area correctly makes a monitor due immediately. Keep
    // this UI fixture out of the independent scheduler test that follows.
    await pool.query("UPDATE fusion_monitors SET next_run=now()+interval '1 hour' WHERE id=$1", [savedArea.id]);
    assert.deepEqual(errors, []);
  } finally {
    cfg.PUBLIC_URL = oldURL;
    try {
      await browser?.close();
    } finally {
      await Promise.all([closeServer(ui), closeServer(apiServer)]);
    }
  }
});

test("automatic worker scheduling handles due monitors and respects retry backoff", async () => {
  await pool.query(
    "UPDATE fusion_monitors SET next_run=now()-interval '1 second' WHERE id=$1",
    [monitor.id],
  );
  let calls = 0;
  await workerCycle(pool, cfg, {
    capture: async () => {
      calls++;
      return { text: "Price 11", screenshot: image(35) };
    },
    send: async () => {},
  });
  assert.equal(calls, 1);
  await workerCycle(pool, cfg, {
    capture: async () => {
      calls++;
      throw Error("must not run before next schedule");
    },
    send: async () => {},
  });
  assert.equal(calls, 1);
});

test("administrator authorization is database-backed; token role claims are ignored", async () => {
  const me = (await ownerAgent.get("/api/v1/users/me")).body;
  const claimed = jwt.sign(
    {
      sub: me.user_id,
      jti: (
        await pool.query(
          "SELECT id FROM fusion_sessions WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1",
          [me.user_id],
        )
      ).rows[0].id,
      admin: true,
      user_type: 2,
    },
    cfg.JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: "2h",
      issuer: "changd-fusion",
      audience: "changd-fusion-ui",
    },
  );
  await request(app)
    .get("/api/v1/users")
    .set("Authorization", "Bearer " + claimed)
    .expect(403);
  await pool.query("UPDATE users SET user_type=2 WHERE user_id=$1", [
    me.user_id,
  ]);
  try {
    await ownerAgent
      .post("/api/v1/security/verify")
      .set("X-Fusion-Request", "1")
      .send({ email: "owner@example.com", password })
      .expect(200);
    await ownerAgent.get("/api/v1/users").expect(200);
  } finally {
    await pool.query("UPDATE users SET user_type=0 WHERE user_id=$1", [
      me.user_id,
    ]);
  }
});

test("public access requires owner credentials to establish a revocable account-security session", async () => {
  const owner = (await pool.query("SELECT user_id,firstname,lastname,email,user_type FROM users WHERE email='owner@example.com'")).rows[0];
  await pool.query("UPDATE fusion_access_settings SET public_enabled=true,owner_user_id=$1 WHERE singleton=true", [owner.user_id]);

  const publicApp = createApp(pool, cfg);
  const visitor = request.agent(publicApp);
  await visitor.get("/api/v1/users/me").expect(200, { user_id: null, firstname: "Public", lastname: "Access", email: null, user_type: 0, public_access: true });
  await visitor.get("/api/v1/account/public-access").expect(403);
  await visitor.get("/api/v1/system/diagnostics").expect(403);
  await visitor
    .post("/api/v1/security/verify")
    .set("X-Fusion-Request", "1")
    .send({ email: "owner@example.com", password: "incorrect" })
    .expect(401);
  await visitor
    .post("/api/v1/security/verify")
    .set("X-Fusion-Request", "1")
    .send({ email: "other@example.com", password })
    .expect(401);

  const stepUp = await visitor
    .post("/api/v1/security/verify")
    .set("X-Fusion-Request", "1")
    .send({ email: "owner@example.com", password })
    .expect(200);
  assert.ok(stepUp.headers["set-cookie"].some((cookie: string) => cookie.startsWith("fusion_session=")));
  assert.ok(stepUp.headers["set-cookie"].some((cookie: string) => cookie.startsWith("fusion_security=")));
  await visitor
    .put("/api/v1/account/public-access")
    .set("X-Fusion-Request", "1")
    .send({ enabled: false, confirm: true })
    .expect(200, { enabled: false });
  await request(publicApp).get("/api/v1/jobs").expect(401);
  await visitor.get("/api/v1/users/me").expect(200, { ...owner, public_access: false });
  await visitor.post("/api/v1/security/leave").set("X-Fusion-Request", "1").send({}).expect(200);
  await visitor.get("/api/v1/account/public-access").expect(403);
});

test("capture modes use one browser page for text and image; limits, selector errors and timeouts preserve baseline", async (t) => {
  let slowHits = 0;
  const fixture = managedServer(t, (req, res) => {
    if (req.url === "/slow") {
      slowHits++;
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<style>body{margin:0}#region{width:320px;height:240px;background:#fff}#bands{position:absolute;left:400px;top:0;width:200px;height:300px}#bands i{display:block;width:200px;height:100px}.red{background:#f00}.green{background:#0f0}.blue{background:#00f}#masked{position:absolute;left:20px;top:120px;width:20px;height:20px;background:#fff}#tall{height:1800px}</style><main id="region">Hybrid region</main><div id="bands"><i class="red"></i><i class="green"></i><i class="blue"></i><b id="masked"></b></div><div id="tall"></div>',
    );
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async () => [{ address: "127.0.0.1", family: 4 }],
    (ip) => ip === "127.0.0.1",
    new Set([port]),
  );
  const base = {
    ...monitor,
    url: `http://fixture.test:${port}`,
    text_enabled: true,
    visual_enabled: true,
    selector: "#region",
    selector_type: "css",
    ignore_selectors: [],
    mask_selectors: [],
    ignore_text: [],
    normalize_whitespace: true,
    ignore_case: false,
  };
  try {
    for (const mode of ["viewport", "full_page", "element"] as const) {
      const result = await capture(
        { ...base, capture_mode: mode, capture_selector: "#region" },
        cfg,
        policy,
      );
      assert.equal(result.text, "Hybrid region");
      const png = PNG.sync.read(result.screenshot!);
      assert.equal(png.width, mode === "element" ? 320 : 1280);
      assert.equal(
        png.height,
        mode === "element" ? 240 : mode === "full_page" ? 2040 : 900,
      );
    }
    const selectedArea = await capture(
      { ...base, capture_mode: "selected_area", capture_area: { x: 400, y: 0, width: 200, height: 300 }, capture_selector: "" },
      cfg,
      policy,
    );
    const selectedPng = PNG.sync.read(selectedArea.screenshot!);
    assert.deepEqual([selectedPng.width, selectedPng.height], [200, 300]);
    const pixel = (x: number, y: number) => [...selectedPng.data.subarray((y * selectedPng.width + x) * 4, (y * selectedPng.width + x) * 4 + 4)];
    assert.deepEqual(pixel(100, 50), [255, 0, 0, 255]);
    assert.deepEqual(pixel(100, 150), [0, 255, 0, 255]);
    assert.deepEqual(pixel(100, 250), [0, 0, 255, 255]);
    const maskedArea = await capture(
      { ...base, capture_mode: "selected_area", capture_area: { x: 400, y: 0, width: 200, height: 300 }, capture_selector: "", mask_selectors: ["#masked"] },
      cfg,
      policy,
    );
    const maskedPng = PNG.sync.read(maskedArea.screenshot!);
    assert.deepEqual([...maskedPng.data.subarray((130 * maskedPng.width + 30) * 4, (130 * maskedPng.width + 30) * 4 + 4)], [255, 0, 255, 255]);
    await assert.rejects(
      capture(
        { ...base, capture_mode: "element", capture_selector: ".missing" },
        cfg,
        policy,
      ),
      (error: any) => error.stage === "selector_lookup" && error.code === "selector_missing",
    );
    const before = (await ownerAgent.get(`/api/v1/jobs/${monitor.id}`)).body;
    await runMonitor(pool, cfg, monitor.id, {
      force: true,
      capture: async () =>
        capture(
          { ...base, capture_mode: "full_page" },
          { ...cfg, MAX_CAPTURE_PIXELS: 1280 * 900 },
          policy,
        ),
    });
    const after = (await ownerAgent.get(`/api/v1/jobs/${monitor.id}`)).body;
    assert.equal(after.baseline_id, before.baseline_id);
    assert.equal(after.latest_capture_id, before.latest_capture_id);
    assert.match(after.last_error, /image dimension\/pixel limits/);
    assert.equal(typeof after.last_capture_timings?.screenshot, "number");
    assert.ok(!JSON.stringify(after.last_capture_timings).includes("fixture.test"));
    const started = Date.now();
    await assert.rejects(
      capture(
        // Explicit NULL models an unchanged pre-migration monitor, which still
        // uses the configured legacy fallback rather than a new override.
        { ...base, url: `http://fixture.test:${port}/slow`, capture_timeout_ms: null },
        { ...cfg, CAPTURE_TIMEOUT_MS: 1500 },
        policy,
      ),
    );
    assert.ok(
      Date.now() - started < 10000,
      "Timeout must close Chromium and its proxy promptly",
    );
    assert.equal(slowHits, 1);
    await assert.rejects(
      capture(
        base,
        { ...cfg, PLAYWRIGHT_EXECUTABLE_PATH: "/missing-synthetic-chromium" },
        policy,
      ),
    );
  } finally {
    await closeServer(fixture);
  }
  await ownerAgent
    .post("/api/v1/jobs")
    .set("X-Fusion-Request", "1")
    .send({
      name: "Missing selector",
      url: "https://example.com",
      visual_enabled: true,
      capture_mode: "element",
    })
    .expect(400);
  const m = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Region configuration",
        url: "https://example.com",
        visual_enabled: true,
        capture_mode: "element",
        capture_selector: "#region",
      })
      .expect(201)
  ).body;
  assert.equal(m.capture_mode, "element");
  await ownerAgent
    .delete(`/api/v1/jobs/${m.id}`)
    .set("X-Fusion-Request", "1")
    .expect(200);
  // Keep the selected-area validation matrix isolated from the shared app's
  // production-equivalent request limiter. The suite deliberately exercises
  // enough unrelated endpoints that adding this matrix to the shared store
  // can rate-limit later regression tests instead of testing their behavior.
  const areaApp = createApp(pool, cfg, new EgressPolicy(async () => [{ address: "8.8.8.8", family: 4 }]));
  const areaAgent = request.agent(areaApp);
  await areaAgent.post("/api/v1/login").set("X-Fusion-Request", "1").send({ email: "owner@example.com", password }).expect(200);
  const area = { x: 100, y: 150, width: 320, height: 180 };
  const areaMonitor = (await areaAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Selected area configuration", url: "https://example.com", kind: "browser", text_enabled: true,
    visual_enabled: true, capture_mode: "selected_area", capture_area: area, channel_ids: [],
  }).expect(201)).body;
  try {
    assert.deepEqual(areaMonitor.capture_area, area);
    assert.deepEqual((await areaAgent.get(`/api/v1/jobs/${areaMonitor.id}`).expect(200)).body.capture_area, area);
    const areaBaseline = randomUUID();
    await pool.query("INSERT INTO fusion_captures(id,monitor_id,screenshot) VALUES($1,$2,$3)", [areaBaseline, areaMonitor.id, "synthetic-selected-area.png"]);
    await pool.query("UPDATE fusion_monitors SET baseline_id=$2,latest_capture_id=$2 WHERE id=$1", [areaMonitor.id, areaBaseline]);
    await areaAgent.put(`/api/v1/jobs/${areaMonitor.id}`).set("X-Fusion-Request", "1").send({
      name: "Selected area configuration", url: "https://example.com", kind: "browser", text_enabled: true,
      visual_enabled: true, capture_mode: "selected_area", capture_area: { ...area, x: 200 }, channel_ids: [],
    }).expect(200);
    const updatedArea = (await areaAgent.get(`/api/v1/jobs/${areaMonitor.id}`).expect(200)).body;
    assert.equal(updatedArea.baseline_id, null);
    assert.equal(updatedArea.latest_capture_id, areaBaseline, "configuration change preserves successful capture history");
    assert.equal((await pool.query("SELECT count(*) FROM fusion_events WHERE monitor_id=$1 AND status='reset' AND configuration_changed=true", [areaMonitor.id])).rows[0].count, "1");
    for (const capture_area of [null, "not-an-object", { x: -1, y: 0, width: 20, height: 20 }, { x: 0.5, y: 0, width: 20, height: 20 }, { x: 1270, y: 0, width: 20, height: 20 }, { x: 0, y: 0, width: 15, height: 20 }, { x: 0, y: 0, width: 20, height: 20, extra: true }])
      await areaAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Invalid area", url: "https://example.com", kind: "browser", text_enabled: false, visual_enabled: true, capture_mode: "selected_area", capture_area, channel_ids: [] }).expect(400);
    await areaAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Invalid area source", url: "https://example.com", kind: "html", text_enabled: true, visual_enabled: false, capture_mode: "selected_area", capture_area: area, channel_ids: [] }).expect(400);
  } finally {
    await pool.query("DELETE FROM fusion_monitors WHERE id=$1", [areaMonitor.id]);
  }
});

test("full-page capture measures the active mobile viewport without inflating resource preflight", async (t) => {
  const fixture = managedServer(t, (req, res) => {
    const pages: Record<string, { height: number; wide?: boolean }> = {
      "/mobile": { height: 844 },
      "/mobile-long": { height: 2000 },
      "/mobile-oversized": { height: 4000 },
      "/mobile-too-wide": { height: 844, wide: true },
      "/desktop": { height: 900 },
    };
    const page = pages[req.url ?? ""];
    if (!page) return void res.writeHead(404).end();
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;padding:0}#surface{width:${page.wide ? "4097px" : "100vw"};height:${page.height}px;background:#246}</style><main id="surface">Fixture</main>`);
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async () => [{ address: "127.0.0.1", family: 4 }],
    (ip) => ip === "127.0.0.1",
    new Set([port]),
  );
  const mobileLimits = { ...cfg, MAX_CAPTURE_PIXELS: 1_200_000 };
  const base = {
    ...monitor,
    url: `http://fixture.test:${port}/mobile`,
    text_enabled: false,
    visual_enabled: true,
    capture_mode: "full_page" as const,
    selector: "",
    selector_type: "css" as const,
    capture_selector: "",
    ignore_selectors: [],
    mask_selectors: [],
    ignore_text: [],
    normalize_whitespace: true,
    ignore_case: false,
    mobile_view: true,
  };
  const dimensions = (result: Awaited<ReturnType<typeof capture>>) => {
    const png = PNG.sync.read(result.screenshot!);
    return { width: png.width, height: png.height };
  };
  try {
    assert.deepEqual(dimensions(await capture(base, mobileLimits, policy)), { width: 390, height: 844 });
    assert.deepEqual(
      dimensions(await capture({ ...base, url: `http://fixture.test:${port}/mobile-long` }, mobileLimits, policy)),
      { width: 390, height: 2000 },
      "a valid long mobile page stays below its real pixel budget",
    );
    await assert.rejects(
      capture({ ...base, url: `http://fixture.test:${port}/mobile-oversized` }, mobileLimits, policy),
      (error: any) => error instanceof CaptureFailure && /image dimension\/pixel limits/.test(error.message),
    );
    await assert.rejects(
      capture({ ...base, url: `http://fixture.test:${port}/mobile-too-wide` }, cfg, policy),
      (error: any) => error instanceof CaptureFailure && /image dimension\/pixel limits/.test(error.message),
    );
    assert.deepEqual(
      dimensions(await capture({ ...base, url: `http://fixture.test:${port}/desktop`, mobile_view: false }, mobileLimits, policy)),
      { width: 1280, height: 900 },
      "desktop full-page capture retains its 1280 × 900 viewport minimum",
    );
  } finally {
    await closeServer(fixture);
  }
});

test("worker concurrency follows configured browser limit and stopping prevents new captures", async () => {
  const ids: string[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      ids.push(
        (
          await ownerAgent
            .post("/api/v1/jobs")
            .set("X-Fusion-Request", "1")
            .send({
              name: "Concurrency fixture " + i,
              url: "https://example.com",
              kind: "html",
            })
            .expect(201)
        ).body.id,
      );
    }
    for (const limit of [1, 2]) {
      await pool.query(
        "UPDATE fusion_monitors SET next_run=now() WHERE id=ANY($1::uuid[])",
        [ids],
      );
      let active = 0,
        max = 0,
        calls = 0;
      await workerCycle(
        pool,
        { ...cfg, CHROMIUM_CONCURRENCY: limit },
        {
          capture: async () => {
            active++;
            calls++;
            max = Math.max(max, active);
            try {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return { text: "fixture", screenshot: null };
            } finally {
              active--;
            }
          },
          send: async () => {},
        },
      );
      assert.equal(max, limit);
      assert.equal(calls, 3);
    }
    let calls = 0;
    await pool.query(
      "UPDATE fusion_monitors SET next_run=now() WHERE id=ANY($1::uuid[])",
      [ids],
    );
    await workerCycle(pool, cfg, {
      stopped: () => true,
      capture: async () => {
        calls++;
        return { text: "", screenshot: null };
      },
      send: async () => {},
    });
    assert.equal(calls, 0);
  } finally {
    for (const id of ids)
      await ownerAgent
        .delete(`/api/v1/jobs/${id}`)
        .set("X-Fusion-Request", "1")
        .expect(200);
  }
});

test("browser steps execute cookie dismissal, dropdown, form fill, CSS/XPath waits and scrolling before one hybrid capture", async (t) => {
  const fixture = managedServer(t, (_req, res) => {
    res.end(
      `<html><style>body{margin:0}main{width:320px;height:240px;background:white}</style><button id="cookie" onclick="this.remove()">Accept cookies</button><input id="field"><select id="choice"><option value="a">A</option><option value="b">B</option></select><button id="apply" onclick="document.querySelector('main').textContent=document.querySelector('#field').value+' '+document.querySelector('#choice').value">Apply</button><main>before</main></html>`,
    );
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(
    async () => [{ address: "127.0.0.1", family: 4 }],
    () => true,
    new Set([port]),
  );
  const steps = [
    { action: "wait_selector", selector: "//main", selector_type: "xpath" },
    { action: "dismiss_cookie", selector: "#cookie" },
    { action: "fill_literal", selector: "#field", value: "synthetic" },
    { action: "select_option", selector: "#choice", value: "b" },
    { action: "click", selector: "#apply" },
    { action: "wait_visible", selector: "main" },
    { action: "scroll_to", selector: "//main", selector_type: "xpath" },
    { action: "scroll_by", y: 20 },
    { action: "delay", duration_ms: 1 },
  ];
  const result = await capture(
    {
      ...monitor,
      url: `http://127.0.0.1:${port}`,
      selector: "//main",
      selector_type: "xpath",
      capture_mode: "element",
      capture_selector: "//main",
      capture_selector_type: "xpath",
      browser_steps: steps,
    } as any,
    cfg,
    policy,
  );
  assert.equal(result.text, "synthetic b");
  assert.ok(result.screenshot);
  assert.equal(PNG.sync.read(result.screenshot).width, 320);
  const optional = await capture(
    {
      ...monitor,
      url: `http://127.0.0.1:${port}`,
      browser_steps: [
        {
          action: "wait_visible",
          selector: "#missing",
          timeout_ms: 100,
          continue_on_error: true,
        },
      ],
    } as any,
    cfg,
    policy,
  );
  assert.equal(optional.warning, "optional_step_failed:1:wait_visible:step_timeout");
  await assert.rejects(
    capture(
      {
        ...monitor,
        url: `http://127.0.0.1:${port}`,
        browser_steps: [
          {
            action: "fill_literal",
            selector: "#missing",
            value: "synthetic-private-fixture",
            timeout_ms: 100,
          },
        ],
      } as any,
      cfg,
      policy,
    ),
    (e) =>
      e instanceof Error &&
      !e.message.includes("synthetic-private-fixture") &&
      e.message.includes("Browser step 1"),
  );
  await assert.rejects(
    capture(
      {
        ...monitor,
        url: `http://127.0.0.1:${port}`,
        capture_mode: "element",
        capture_selector: "button",
        browser_steps: [],
      } as any,
      cfg,
      policy,
    ),
    /exactly one/,
  );
  await assert.rejects(
    capture(
      {
        ...monitor,
        url: `http://127.0.0.1:${port}`,
        browser_steps: [{ action: "delay", duration_ms: 5000 }],
        step_budget_ms: 100,
      } as any,
      cfg,
      policy,
    ),
    /Browser step/,
  );
});

test("HTTP error-page monitoring preserves final status, skips unavailable steps and uses viewport fallback", async (t) => {
  const requests = new Map<string, number>();
  const fixture = managedServer(t, (req, res) => {
    const path = req.url ?? "/";
    requests.set(path, (requests.get(path) ?? 0) + 1);
    if (path === "/start") {
      res.end(`<button id="go" onclick="location.href='/403'">Continue</button><main>healthy</main>`);
      return;
    }
    if (path === "/challenge") {
      res.statusCode = 403;
      res.end(`<title>Verify you are human</title><div class="cf-challenge">Synthetic challenge</div>`);
      return;
    }
    if (path === "/login") {
      res.statusCode = 401;
      res.end(`<title>Sign in</title><input type="password">`);
      return;
    }
    const status = Number(path.slice(1));
    res.statusCode = Number.isInteger(status) ? status : 200;
    res.end(`<main style="width:200px;height:100px;background:rgb(20,40,60)">HTTP ${res.statusCode} fixture</main>`);
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;

  for (const status of [403, 404, 429, 500]) {
    const result = await capture({
      ...monitor,
      url: url(`/${status}`),
      monitor_http_error_pages: true,
      visual_enabled: true,
      capture_mode: "element",
      capture_selector: "#missing-on-error-page",
      browser_steps: [{ action: "wait_visible", selector: "#missing-on-error-page", timeout_ms: 100 }],
    } as any, cfg, policy);
    assert.equal(result.http_status, status);
    assert.equal(result.warning, "browser_steps_skipped_http_error");
    assert.equal(PNG.sync.read(result.screenshot!).width, 1280);
    assert.equal(PNG.sync.read(result.screenshot!).height, 900);
    assert.match(result.text ?? "", new RegExp(`HTTP ${status}`));
  }
  assert.equal(requests.get("/429"), 1, "HTTP 429 is observed once and never retried");
  await assert.rejects(
    capture({ ...monitor, url: url("/403"), monitor_http_error_pages: false } as any, cfg, policy),
    /unsuccessful|Access denied/i,
  );
  await assert.rejects(
    capture({ ...monitor, url: url("/challenge"), monitor_http_error_pages: true } as any, cfg, policy),
    (error: any) => error?.state === "challenge_detected",
  );
  await assert.rejects(
    capture({ ...monitor, url: url("/login"), monitor_http_error_pages: true } as any, cfg, policy),
    (error: any) => error?.state === "authentication_required",
  );

  const navigated = await capture({
    ...monitor,
    url: url("/start"),
    monitor_http_error_pages: true,
    browser_steps: [
      { action: "click", selector: "#go", timeout_ms: 2000 },
      { action: "wait_navigation", path: "/403", timeout_ms: 2000 },
      { action: "wait_visible", selector: "#not-on-error-page", timeout_ms: 100 },
    ],
  } as any, cfg, policy);
  assert.equal(navigated.http_status, 403);
  assert.equal(navigated.warning, "browser_steps_skipped_http_error");

  const areaFallback = await capture({
    ...monitor,
    url: url("/500"),
    monitor_http_error_pages: true,
    visual_enabled: true,
    capture_mode: "selected_area",
    capture_area: { x: 10, y: 10, width: 32, height: 32 },
  } as any, cfg, policy);
  const dimensions = PNG.sync.read(areaFallback.screenshot!);
  assert.deepEqual({ width: dimensions.width, height: dimensions.height }, { width: 1280, height: 900 });
});

test("browser challenge fixtures distinguish denied, login and heuristic CAPTCHA without solving", async (t) => {
  const fixture = managedServer(t, (req, res) => {
    if (req.url === "/denied") {
      res.statusCode = 403;
      res.end("Forbidden");
    } else if (req.url === "/unauthorized") {
      res.statusCode = 401;
      res.end("Unauthorized");
    } else if (req.url === "/login")
      res.end('<title>Sign in</title><input type="password">');
    else if (req.url === "/challenge")
      res.end(
        '<title>Just a moment...</title><div id="challenge-running">Verify</div>',
      );
    else
      res.end(
        "<title>Article about CAPTCHA</title><main>Normal content</main>",
      );
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port,
    policy = new EgressPolicy(
      async () => [{ address: "127.0.0.1", family: 4 }],
      () => true,
      new Set([port]),
    );
  for (const [path, message, expectedCode] of [
    ["/denied", "does not confirm a CAPTCHA", "http_403"],
    ["/unauthorized", "HTTP 401", null],
    ["/login", "Possible login screen", null],
    ["/challenge", "Possible browser challenge", null],
  ])
    await assert.rejects(
      capture(
        {
          ...monitor,
          url: `http://127.0.0.1:${port}${path}`,
          selector: "",
          browser_steps: [],
        } as any,
        cfg,
        policy,
      ),
      (e) => {
        assert.ok(e instanceof Error && e.message.includes(message));
        if (expectedCode) {
          assert.ok(e instanceof CaptureFailure);
          assert.equal(e.stage, "navigation");
          assert.equal(e.code, expectedCode);
          assert.equal(e.httpStatus, 403);
        }
        return true;
      },
    );
  const normal = await capture(
    {
      ...monitor,
      url: `http://127.0.0.1:${port}/article`,
      selector: "",
      browser_steps: [],
    } as any,
    cfg,
    policy,
  );
  assert.equal(normal.text, "Normal content");
});

test("account sessions revoke cookie and bearer tokens on logout, logout-all, expiration and password changes", async () => {
  const securityApp = createApp(pool, cfg),
    email = "sessions@example.com",
    other = "sessions-other@example.com";
  await pool.query("INSERT INTO users(email,password) VALUES($1,$3),($2,$3)", [
    email,
    other,
    await hash(password, 4),
  ]);
  const login = async (address = email, pass = password) => {
    const r = await request(securityApp)
      .post("/api/v1/login")
      .set("X-Fusion-Request", "1")
      .send({ email: address, password: pass })
      .expect(200);
    return r.headers["set-cookie"][0]
      .split(";")[0]
      .slice("fusion_session=".length);
  };
  const me = (token: string) =>
    request(securityApp)
      .get("/api/v1/users/me")
      .set("Authorization", "Bearer " + token);
  const post = (token: string, path: string, body = {}) =>
    request(securityApp)
      .post("/api/v1/" + path)
      .set("X-Fusion-Request", "1")
      .set("Authorization", "Bearer " + token)
      .send(body);
  const verify = async (token: string, pass = password) => {
    const response = await request(securityApp)
      .post("/api/v1/security/verify")
      .set("X-Fusion-Request", "1")
      .set("Authorization", "Bearer " + token)
      .send({ email, password: pass });
    return response;
  };
  const one = await login(),
    two = await login(),
    foreign = await login(other);
  await post(one, "logout").expect(200);
  await me(one).expect(401);
  await request(securityApp)
    .get("/api/v1/users/me")
    .set("Cookie", "fusion_session=" + one)
    .expect(401);
  await me(two).expect(200);
  const logoutAllGrant = await verify(two);
  assert.equal(logoutAllGrant.status, 200);
  await post(two, "logout-all")
    .set("Cookie", logoutAllGrant.headers["set-cookie"][0].split(";")[0])
    .expect(200);
  await me(two).expect(401);
  await me(foreign).expect(200);
  const three = await login(),
    four = await login();
  assert.equal((await verify(three, "incorrect")).status, 401);
  await me(three).expect(200);
  const passwordGrant = await verify(three);
  assert.equal(passwordGrant.status, 200);
  await post(three, "users/changepassword", {
    password: "synthetic-new-password",
  }).set("Cookie", passwordGrant.headers["set-cookie"][0].split(";")[0]).expect(200);
  await me(three).expect(401);
  await me(four).expect(401);
  await me(foreign).expect(200);
  const five = await login(email, "synthetic-new-password"),
    decoded = jwt.decode(five) as jwt.JwtPayload;
  await pool.query(
    "UPDATE fusion_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
    [decoded.jti],
  );
  await me(five).expect(401);
  const sign = (payload: any) =>
    jwt.sign(payload, cfg.JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: "2h",
      issuer: "changd-fusion",
      audience: "changd-fusion-ui",
    });
  await me(sign({ sub: decoded.sub })).expect(401);
  await me(sign({ sub: decoded.sub, jti: randomUUID() })).expect(401);
  const otherDecoded = jwt.decode(foreign) as jwt.JwtPayload;
  await me(sign({ sub: decoded.sub, jti: otherDecoded.jti })).expect(401);
});

test("private vault is write-only, owner-bound and expiring; missing values preserve baseline and trigger one attention alert", async () => {
  const m = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Private fixture",
        url: "https://example.com",
        browser_steps: [
          {
            action: "fill_private",
            selector: "#account",
            credential: "fixture",
          },
        ],
        notify_attention: true,
        channel_ids: [channelId],
      })
      .expect(201)
  ).body;
  const values = { fixture: "synthetic-sensitive-fixture" },
    path = `/api/v1/jobs/${m.id}/private-values`,
    body = { values, expires_at: new Date(Date.now() + 60000).toISOString() };
  await otherAgent
    .put(path)
    .set("X-Fusion-Request", "1")
    .send(body)
    .expect(404);
  await otherAgent.get(path).expect(404);
  await otherAgent.delete(path).set("X-Fusion-Request", "1").expect(404);
  await ownerAgent
    .put(path)
    .set("X-Fusion-Request", "1")
    .send(body)
    .expect(200);
  const metadata = (await ownerAgent.get(path).expect(200)).body;
  assert.deepEqual(metadata.value_names, ["fixture"]);
  assert.ok(!JSON.stringify(metadata).includes(values.fixture));
  assert.ok(
    !JSON.stringify(
      (await ownerAgent.get(`/api/v1/jobs/${m.id}`).expect(200)).body,
    ).includes(values.fixture),
  );
  const encrypted = (
    await pool.query(
      "SELECT encrypted FROM fusion_monitor_vault WHERE monitor_id=$1",
      [m.id],
    )
  ).rows[0].encrypted;
  assert.ok(!encrypted.includes(values.fixture));
  await runMonitor(pool, cfg, m.id, {
    force: true,
    capture: async (mon) => {
      assert.deepEqual(mon.private_values, values);
      return { text: "redacted synthetic capture", screenshot: null };
    },
  });
  const baseline = (
    await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [
      m.id,
    ])
  ).rows[0].baseline_id;
  await pool.query(
    "UPDATE fusion_monitor_vault SET expires_at=now()-interval '1 second' WHERE monitor_id=$1",
    [m.id],
  );
  for (let i = 0; i < 2; i++)
    await runMonitor(pool, cfg, m.id, {
      force: true,
      capture: async () => {
        throw Error("capture must not run after expiry");
      },
    });
  const state = (
    await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [m.id])
  ).rows[0];
  assert.equal(state.monitor_state, "authentication_required");
  assert.equal(state.baseline_id, baseline);
  assert.equal(state.latest_capture_id, baseline);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1",
        [m.id],
      )
    ).rows[0].count,
    "1",
  );
  await ownerAgent.delete(path).set("X-Fusion-Request", "1").expect(200);
  assert.deepEqual((await ownerAgent.get(path)).body.value_names, []);
  await ownerAgent
    .put(path)
    .set("X-Fusion-Request", "1")
    .send({ ...body, expires_at: new Date(0).toISOString() })
    .expect(400);
  await ownerAgent
    .post("/api/v1/jobs")
    .set("X-Fusion-Request", "1")
    .send({
      name: "Unsafe private visual",
      url: "https://example.com",
      visual_enabled: true,
      browser_steps: [
        { action: "fill_private", selector: "#x", credential: "fixture" },
      ],
    })
    .expect(400);
});

test("failure state transitions preserve captures, back off and honor the legacy first-or-persistent alert policy", async () => {
  const { AttentionFailure } = await import("../../src/attention.js");
  const m = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Failure fixture",
        url: "https://example.com",
        notify_failures: true,
        notify_attention: true,
        channel_ids: [channelId],
      })
      .expect(201)
  ).body;
  await runMonitor(pool, cfg, m.id, {
    force: true,
    capture: async () => ({ text: "baseline", screenshot: null }),
  });
  const baseline = (
    await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [
      m.id,
    ])
  ).rows[0].baseline_id;
  for (let i = 0; i < 4; i++)
    await runMonitor(pool, cfg, m.id, {
      force: true,
      capture: async () => {
        throw Error("synthetic raw sensitive error bot-token=123:secret cookie=private&password=hidden");
      },
    });
  let state = (
    await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [m.id])
  ).rows[0];
  assert.equal(state.monitor_state, "persistent_failure");
  assert.equal(state.failure_count, 4);
  assert.equal(state.baseline_id, baseline);
  assert.equal(state.latest_capture_id, baseline);
  assert.ok(state.execution_ms >= 0);
  assert.ok(state.last_success_at);
  assert.ok(!state.last_error.includes("sensitive"));
  assert.equal(state.failure_stage, "unknown");
  assert.equal(state.failure_code, "unknown");
  assert.ok(!JSON.stringify(state).includes("bot-token"));
  const count = async () =>
    (
      await pool.query(
        "SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1",
        [m.id],
      )
    ).rows[0].count;
  // Legacy notify_failures=true migrates to first_or_persistent: the first
  // failure and the transition to persistent failure each enter the existing
  // notification pipeline exactly once.
  assert.equal(await count(), "2");
  for (let i = 0; i < 2; i++)
    await runMonitor(pool, cfg, m.id, {
      force: true,
      capture: async () => {
        throw new AttentionFailure(
          "challenge_detected",
          "heuristic",
          "Possible browser challenge detected.",
        );
      },
    });
  state = (
    await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [m.id])
  ).rows[0];
  assert.equal(state.monitor_state, "challenge_detected");
  assert.equal(state.warning_code, "heuristic");
  assert.ok(state.next_run.getTime() - state.last_run.getTime() >= 900000);
  assert.equal(await count(), "3");
  await runMonitor(pool, cfg, m.id, {
    force: true,
    capture: async () => ({ text: "baseline", screenshot: null }),
  });
  state = (
    await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [m.id])
  ).rows[0];
  assert.equal(state.monitor_state, "unchanged");
  assert.equal(state.failure_count, 0);
  assert.equal(state.warning_code, null);
});

test("failure alert modes preserve mute/dedupe pipeline entry semantics", async () => {
  const expected = new Map([["off", 0], ["first_or_persistent", 2], ["every", 3]] as const);
  for (const [mode, notifications] of expected) {
    const monitor = (await ownerAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
      name: `Failure mode ${mode}`,
      url: "https://example.com",
      failure_alert_mode: mode,
      channel_ids: [channelId],
    }).expect(201)).body;
    for (let attempt = 0; attempt < 3; attempt++) {
      await runMonitor(pool, cfg, monitor.id, { force: true, capture: async () => { throw new Error("synthetic capture failure"); } });
    }
    const count = Number((await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [monitor.id])).rows[0].count);
    assert.equal(count, notifications, mode);
  }

  const every = (await ownerAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Every failure resets safely",
    url: "https://example.com",
    failure_alert_mode: "every",
    channel_ids: [channelId],
  }).expect(201)).body;
  const failEvery = () => runMonitor(pool, cfg, every.id, { force: true, capture: async () => { throw new Error("every failure"); } });
  await failEvery();
  await runMonitor(pool, cfg, every.id, { force: true, capture: async () => ({ text: "recovered", screenshot: null }) });
  await failEvery();
  await failEvery();
  await failEvery();
  const everyEvents = (await pool.query("SELECT notification_state FROM fusion_events WHERE monitor_id=$1 AND status='failed' ORDER BY created_at,id", [every.id])).rows;
  assert.deepEqual(everyEvents.map((event) => event.notification_state), ["queued", "queued", "queued", "queued"], "every failure remains deliverable after a success resets its ordinal");
  assert.equal(Number((await pool.query("SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1", [every.id])).rows[0].count), 4, "consecutive every-mode failures do not deduplicate");

  const muted = (await ownerAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Every failure muted",
    url: "https://example.com",
    failure_alert_mode: "every",
    muted_until: new Date(Date.now() + 60_000).toISOString(),
    channel_ids: [channelId],
  }).expect(201)).body;
  await runMonitor(pool, cfg, muted.id, { force: true, capture: async () => { throw new Error("every failure"); } });
  assert.equal((await pool.query("SELECT notification_state FROM fusion_events WHERE monitor_id=$1 AND status='failed'", [muted.id])).rows[0].notification_state, "muted");

  const cooldown = (await ownerAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Every failure cooldown",
    url: "https://example.com",
    failure_alert_mode: "every",
    notification_cooldown_seconds: 300,
    channel_ids: [channelId],
  }).expect(201)).body;
  for (let attempt = 0; attempt < 2; attempt++) await runMonitor(pool, cfg, cooldown.id, { force: true, capture: async () => { throw new Error("every failure"); } });
  assert.deepEqual((await pool.query("SELECT notification_state FROM fusion_events WHERE monitor_id=$1 AND status='failed' ORDER BY created_at,id", [cooldown.id])).rows.map((event) => event.notification_state), ["queued", "cooldown"]);

  const digest = (await ownerAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({
    name: "Every failure digest",
    url: "https://example.com",
    failure_alert_mode: "every",
    notification_mode: "digest",
    digest_window_seconds: 300,
    channel_ids: [channelId],
  }).expect(201)).body;
  for (let attempt = 0; attempt < 2; attempt++) await runMonitor(pool, cfg, digest.id, { force: true, capture: async () => { throw new Error("every failure"); } });
  assert.deepEqual((await pool.query("SELECT notification_state FROM fusion_events WHERE monitor_id=$1 AND status='failed' ORDER BY created_at,id", [digest.id])).rows.map((event) => event.notification_state), ["digest_pending", "digest_pending"]);
  assert.equal((await pool.query("SELECT event_count FROM fusion_notification_digests WHERE monitor_id=$1", [digest.id])).rows[0].event_count, 2);
});

test("pagination, configuration resets, paused scheduling and delivery retry enforce ownership", async () => {
  const m = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Pagination fixture",
        url: "https://example.com",
        channel_ids: [channelId],
      })
      .expect(201)
  ).body;
  for (const text of ["one", "two", "three"])
    await runMonitor(pool, cfg, m.id, {
      force: true,
      capture: async () => ({ text, screenshot: null }),
    });
  const baseline = (
    await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [
      m.id,
    ])
  ).rows[0].baseline_id;
  const page1 = (
      await ownerAgent
        .get(`/api/v1/jobs/${m.id}/history?page=1&page_size=2`)
        .expect(200)
    ).body,
    page2 = (
      await ownerAgent
        .get(`/api/v1/jobs/${m.id}/history?page=2&page_size=2`)
        .expect(200)
    ).body;
  assert.equal(page1.total, 3);
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items.length, 1);
  assert.ok(!page1.items.some((e: any) => e.id === page2.items[0].id));
  await otherAgent.get(`/api/v1/jobs/${m.id}/history?page=1`).expect(404);
  await ownerAgent.get(`/api/v1/jobs/${m.id}/history?page=0`).expect(400);
  await ownerAgent
    .put(`/api/v1/jobs/${m.id}`)
    .set("X-Fusion-Request", "1")
    .send({
      name: "Renamed",
      url: "https://example.com",
      channel_ids: [channelId],
      paused: true,
    })
    .expect(200);
  assert.equal(
    (
      await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [
        m.id,
      ])
    ).rows[0].baseline_id,
    baseline,
  );
  assert.equal(
    await runMonitor(pool, cfg, m.id, {
      force: true,
      capture: async () => {
        throw Error("paused capture must not run");
      },
    }),
    false,
  );
  await ownerAgent
    .post(`/api/v1/jobs/${m.id}/run`)
    .set("X-Fusion-Request", "1")
    .expect(409);
  await ownerAgent
    .put(`/api/v1/jobs/${m.id}`)
    .set("X-Fusion-Request", "1")
    .send({
      name: "Renamed",
      url: "https://example.com",
      selector: "#new-region",
      channel_ids: [channelId],
    })
    .expect(200);
  assert.equal(
    (
      await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [
        m.id,
      ])
    ).rows[0].baseline_id,
    null,
  );
  const reset = (
    await ownerAgent.get(`/api/v1/jobs/${m.id}/history?status=reset&page=1`)
  ).body.items[0];
  assert.equal(reset.configuration_changed, true);
  assert.ok(
    (await pool.query("SELECT id FROM fusion_captures WHERE id=$1", [baseline]))
      .rowCount,
  );
  const outbox = (
    await pool.query(
      "SELECT o.id FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1 LIMIT 1",
      [m.id],
    )
  ).rows[0].id;
  await pool.query(
    "UPDATE fusion_outbox SET status='failed',attempts=5 WHERE id=$1",
    [outbox],
  );
  const deliveries = (
    await ownerAgent
      .get("/api/v1/deliveries?page=1&page_size=100&status=failed")
      .expect(200)
  ).body;
  assert.ok(deliveries.items.some((d: any) => d.id === outbox));
  assert.ok(
    !(await otherAgent.get("/api/v1/deliveries")).body.items.some(
      (d: any) => d.id === outbox,
    ),
  );
  await ownerAgent
    .post(`/api/v1/deliveries/${outbox}/retry`)
    .set("X-Fusion-Request", "1")
    .expect(403);
  const me = (await ownerAgent.get("/api/v1/users/me")).body;
  await pool.query("UPDATE users SET user_type=2 WHERE user_id=$1", [
    me.user_id,
  ]);
  try {
    await ownerAgent
      .post(`/api/v1/deliveries/${outbox}/retry`)
      .set("X-Fusion-Request", "1")
      .expect(202);
    const row = (
      await pool.query("SELECT * FROM fusion_outbox WHERE id=$1", [outbox])
    ).rows[0];
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 0);
  } finally {
    await pool.query("UPDATE users SET user_type=0 WHERE user_id=$1", [
      me.user_id,
    ]);
  }
});

test("notification retries stop permanently at five attempts with bounded exponential backoff", async () => {
  await pool.query(
    "UPDATE fusion_outbox SET next_attempt=now()+interval '1 day' WHERE status IN ('pending','sending')",
  );
  const m = (
    await ownerAgent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Retry fixture",
        url: "https://example.com",
        channel_ids: [channelId],
      })
      .expect(201)
  ).body;
  await runMonitor(pool, cfg, m.id, {
    force: true,
    capture: async () => ({ text: "before", screenshot: null }),
  });
  await runMonitor(pool, cfg, m.id, {
    force: true,
    capture: async () => ({ text: "after", screenshot: null }),
  });
  const id = (
    await pool.query(
      "SELECT o.id FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1",
      [m.id],
    )
  ).rows[0].id;
  let sent = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await pool.query(
      "UPDATE fusion_outbox SET next_attempt=now() WHERE id=$1",
      [id],
    );
    await dispatch(pool, cfg, async (_provider, _config, event) => {
      assert.equal(event.monitorId, m.id);
      sent++;
      throw Error("synthetic provider error with private details");
    });
    const row = (
      await pool.query("SELECT * FROM fusion_outbox WHERE id=$1", [id])
    ).rows[0];
    assert.equal(row.attempts, attempt);
    assert.equal(row.status, attempt === 5 ? "failed" : "pending");
    assert.equal(row.last_error, "Provider delivery failed");
    const delay = row.next_attempt.getTime() - Date.now();
    assert.ok(delay >= 30 * 2 ** attempt * 1000 - 2000 && delay <= 3600000);
  }
  await dispatch(pool, cfg, async () => {
    sent++;
  });
  assert.equal(sent, 5);
});

test("private preview seed migrates all versions, is idempotent, preserves changed passwords and stays paused without notifications", async () => {
  const name = "fusion_preview_" + randomUUID().replaceAll("-", "");
  const url = new URL(dbURL);
  url.pathname = "/" + name;
  const seededPool = makePool(url.href);
  const dir = await mkdtemp(path.join(os.tmpdir(), "fusion-preview-seed-"));
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    await migrate(seededPool);
    const seededCfg = { ...cfg, DATABASE_URL: url.href, DATA_DIR: dir };
    await seedPreview(seededPool, seededCfg, "synthetic-preview-password");
    assert.equal(
      (await seededPool.query("SELECT count(*) FROM fusion_migrations")).rows[0]
        .count,
      String(expectedMigrationCount),
    );
    assert.equal(
      (await seededPool.query("SELECT count(*) FROM users")).rows[0].count,
      "1",
    );
    const monitor = (await seededPool.query("SELECT * FROM fusion_monitors"))
      .rows[0];
    assert.ok(monitor.paused && monitor.text_enabled && monitor.visual_enabled);
    assert.equal(monitor.monitor_state, "paused");
    const event = (
      await seededPool.query(
        "SELECT * FROM fusion_events WHERE status='changed'",
      )
    ).rows[0];
    assert.equal(event.visual_percent, "0.3500000000");
    const images = (
      await seededPool.query(
        "SELECT screenshot FROM fusion_captures ORDER BY text_content",
      )
    ).rows;
    const buffers = await Promise.all(
      images.map((row) => readFile(path.join(dir, row.screenshot))),
    );
    const comparison = compareVisual(buffers[0], buffers[1], "0.30", 0.1);
    assert.equal(comparison.percent, "0.3500000000");
    assert.equal(comparison.changed, true);
    await seededPool.query("UPDATE users SET password=$1", [
      "synthetic-changed-hash",
    ]);
    await seedPreview(seededPool, seededCfg, "synthetic-other-password");
    assert.equal(
      (await seededPool.query("SELECT password FROM users")).rows[0].password,
      "synthetic-changed-hash",
    );
    assert.equal(
      (await seededPool.query("SELECT count(*) FROM fusion_monitors")).rows[0]
        .count,
      "1",
    );
    assert.equal(
      (await seededPool.query("SELECT count(*) FROM fusion_events")).rows[0]
        .count,
      "2",
    );
    await workerCycle(seededPool, seededCfg, {
      capture: async () => {
        throw Error("Paused fixture must never make a request");
      },
      send: async () => {
        throw Error("Preview must never send automatically");
      },
    });
    assert.equal(
      (await seededPool.query("SELECT count(*) FROM fusion_outbox")).rows[0]
        .count,
      "0",
    );
    assert.equal(
      (await seededPool.query("SELECT count(*) FROM fusion_channels")).rows[0]
        .count,
      "0",
    );
  } finally {
    await seededPool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-origin production preview preserves Secure cookies, validates Host/Origin and supports owned API/history/screenshots/logout", async () => {
  const publicURL = "https://synthetic-preview-fixture-3000.app.github.dev";
  const host = new URL(publicURL).host;
  const previewCfg = {
    ...cfg,
    NODE_ENV: "production" as const,
    PUBLIC_URL: publicURL,
    DATA_DIR: path.join(root, ".hidden-preview-artifacts"),
  };
  const previewApp = createApp(
    pool,
    previewCfg,
    new EgressPolicy(async () => [{ address: "8.8.8.8", family: 4 }]),
    {
      frontendDir: path.resolve("../frontend/dist"),
      allowedHosts: [host],
    },
  );
  const email = "preview-transport@example.com";
  await pool.query(
    "INSERT INTO users(email,password,firstname) VALUES($1,$2,'Preview')",
    [email, await hash(password, 4)],
  );
  const call = (method: "get" | "post", url: string, cookie?: string) => {
    const r = request(previewApp)
      [method](url)
      .set("Host", host)
      .set("Origin", publicURL)
      .set("X-Fusion-Request", "1");
    if (cookie) r.set("Cookie", cookie);
    return r;
  };
  await request(previewApp).get("/").set("Host", "example.com").expect(400);
  const page = await call("get", "/").expect(200);
  assert.ok(page.text.includes("Changd"));
  assert.ok(
    page.headers["content-security-policy"].includes("script-src 'self'"),
  );
  const login = await call("post", "/api/v1/login")
    .send({ email, password })
    .expect(200);
  const cookieHeader = login.headers["set-cookie"][0];
  assert.ok(
    cookieHeader.includes("Secure") &&
      cookieHeader.includes("HttpOnly") &&
      cookieHeader.includes("SameSite=Strict"),
  );
  const cookie = cookieHeader.split(";")[0];
  await call("get", "/api/v1/users/me", cookie).expect(200);
  await call("post", "/api/v1/jobs", cookie)
    .set("Origin", "https://example.com")
    .send({})
    .expect(403);
  const monitor = (
    await call("post", "/api/v1/jobs", cookie)
      .send({
        name: "Private preview fixture",
        url: "https://example.com",
        text_enabled: true,
        visual_enabled: true,
        visual_threshold: "0.30",
        browser_steps: [
          {
            action: "wait_visible",
            selector: "//main",
            selector_type: "xpath",
          },
        ],
      })
      .expect(201)
  ).body;
  const manualRequest = await call("post", `/api/v1/jobs/${monitor.id}/run`, cookie)
    .send({})
    .expect(202);
  await runMonitor(pool, previewCfg, monitor.id, {
    force: true,
    manualRunId: manualRequest.body.request_id,
    capture: async () => ({ text: "before", screenshot: image(0) }),
  });
  const manualIntent = (await pool.query("SELECT priority_intent_id FROM fusion_manual_runs WHERE id=$1", [manualRequest.body.request_id])).rows[0].priority_intent_id;
  await cancelInteractivePriorityIntent(pool, manualIntent);
  await runMonitor(pool, previewCfg, monitor.id, {
    force: true,
    capture: async () => ({ text: "after", screenshot: image(35) }),
  });
  const history = (
    await call(
      "get",
      `/api/v1/jobs/${monitor.id}/history?page=1`,
      cookie,
    ).expect(200)
  ).body;
  assert.equal(history.total, 2);
  const changed = history.items.find((e: any) => e.status === "changed");
  assert.ok(
    changed,
    JSON.stringify(
      history.items.map((e: any) => ({ status: e.status, error: e.error })),
    ),
  );
  assert.equal(changed.visual_percent, "0.3500000000");
  assert.ok(changed.text_changed && changed.visual_changed);
  const filename = (
    await pool.query("SELECT screenshot FROM fusion_captures WHERE id=$1", [
      changed.after_id,
    ])
  ).rows[0].screenshot;
  const screenshotResponse = await call(
    "get",
    `/api/v1/screenshots/${filename}`,
    cookie,
  ).expect(200);
  assert.equal(
    screenshotResponse.headers["cache-control"],
    "private, no-store",
  );
  await call("get", "/.preview/credentials.json", cookie).expect(404);
  await call("get", "/api/v1/notifications", cookie).expect(200);
  await call("post", "/api/v1/logout", cookie).send({}).expect(200);
  await call("get", "/api/v1/users/me", cookie).expect(401);
});

test("Codespaces Telegram requires an explicit successful owned test before automatic delivery, and changed credentials revoke approval", async () => {
  const previewApp = createApp(
    pool,
    cfg,
    new EgressPolicy(async () => [{ address: "8.8.8.8", family: 4 }]),
    { requireNotificationTest: true },
  );
  const email = "telegram-preview@example.com";
  await pool.query(
    "INSERT INTO users(email,password,firstname) VALUES($1,$2,'Preview')",
    [email, await hash(password, 4)],
  );
  const agent = request.agent(previewApp);
  await agent
    .post("/api/v1/login")
    .set("X-Fusion-Request", "1")
    .send({ email, password })
    .expect(200);
  const config = { token: "123456:" + "x".repeat(24), chat_id: "-123456" };
  const channel = (
    await agent
      .post("/api/v1/notifications")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Telegram preview fixture",
        provider: "telegram",
        enabled: true,
        config,
      })
      .expect(201)
  ).body;
  assert.equal(channel.test_required, true);
  assert.equal(channel.config.token, undefined);
  const monitor = (
    await agent
      .post("/api/v1/jobs")
      .set("X-Fusion-Request", "1")
      .send({
        name: "Telegram gated fixture",
        url: "https://example.com",
        channel_ids: [channel.id],
      })
      .expect(201)
  ).body;
  const take = (text: string) =>
    runMonitor(pool, cfg, monitor.id, {
      force: true,
      capture: async () => ({ text, screenshot: null }),
    });
  await take("before");
  await take("after");
  const sent: string[] = [];
  const send = async (_provider: any, _config: any, event: any) => {
    if (event.monitorId === monitor.id) sent.push(event.eventType);
  };
  await dispatch(pool, cfg, send);
  assert.equal(sent.length, 0);
  const blocked = (
    await pool.query(
      "SELECT status,last_error FROM fusion_outbox WHERE channel_id=$1",
      [channel.id],
    )
  ).rows[0];
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.last_error, "Test notification required");
  await agent
    .post(`/api/v1/notifications/${channel.id}/test`)
    .set("X-Fusion-Request", "1")
    .send({ monitor_id: monitor.id })
    .expect(202);
  await dispatch(pool, cfg, send);
  assert.deepEqual(sent, ["test"]);
  assert.equal(
    (await agent.get("/api/v1/notifications").expect(200)).body[0]
      .test_required,
    false,
  );
  await take("next content");
  await dispatch(pool, cfg, send);
  assert.deepEqual(sent, ["test", "changed"]);
  await agent
    .put(`/api/v1/notifications/${channel.id}`)
    .set("X-Fusion-Request", "1")
    .send({
      name: "Telegram preview fixture",
      provider: "telegram",
      enabled: true,
      config: { ...config, token: "123456:" + "y".repeat(24) },
    })
    .expect(200);
  assert.equal(
    (await agent.get("/api/v1/notifications").expect(200)).body[0]
      .test_required,
    true,
  );
  await take("latest content");
  await dispatch(pool, cfg, send);
  assert.deepEqual(sent, ["test", "changed"]);
  const smtp = {
    host: "smtp.example.com",
    port: 587,
    password: "synthetic-fixture",
    username: "fixture",
    from: "alerts@example.com",
    to: "recipient@example.com",
  };
  const mail = (
    await agent
      .post("/api/v1/notifications")
      .set("X-Fusion-Request", "1")
      .send({
        name: "SMTP edit fixture",
        provider: "smtp",
        enabled: false,
        config: smtp,
      })
      .expect(201)
  ).body;
  await agent
    .put(`/api/v1/notifications/${mail.id}`)
    .set("X-Fusion-Request", "1")
    .send({
      name: "SMTP edit fixture",
      provider: "smtp",
      enabled: false,
      config: { ...smtp, password: "" },
    })
    .expect(200);
  const stored = (
    await pool.query("SELECT config FROM fusion_channels WHERE id=$1", [
      mail.id,
    ])
  ).rows[0].config;
  assert.ok(
    decrypt(stored.encrypted, cfg.CHANNEL_KEY).password === smtp.password,
  );
});

test("monitoring defaults and bulk channel assignment are owner-scoped and transactional", async () => {
  // A dedicated app gives this authorization test an independent test-only limiter store.
  const bulkApp = createApp(pool, cfg, new EgressPolicy(async () => [{ address: "8.8.8.8", family: 4 }]));
  const bulkOwner = request.agent(bulkApp), bulkOther = request.agent(bulkApp);
  for (const [agent, email] of [[bulkOwner, "owner@example.com"], [bulkOther, "other@example.com"]] as const) await agent.post("/api/v1/login").set("X-Fusion-Request", "1").send({ email, password }).expect(200);
  const freshMonitor = (await bulkOther.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Fresh timeout fixture", url: "https://example.com/fresh-timeout", kind: "browser", text_enabled: true, visual_enabled: false, channel_ids: [] }).expect(201)).body;
  assert.equal(freshMonitor.capture_timeout_ms, 60000);
  const explicitLegacyMonitor = (await bulkOther.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Explicit legacy timeout fixture", url: "https://example.com/explicit-legacy-timeout", kind: "browser", text_enabled: true, visual_enabled: false, capture_timeout_ms: null, channel_ids: [] }).expect(201)).body;
  assert.equal(explicitLegacyMonitor.capture_timeout_ms, null);
  const defaults = { interval_seconds: 900, capture_timeout_ms: 90000, capture_mode: "viewport", notification_mode: "digest", notification_cooldown_seconds: 900, channel_ids: [channelId] };
  await bulkOwner.put("/api/v1/preferences/monitoring").set("X-Fusion-Request", "1").send(defaults).expect(200);
  const savedDefaults = (await bulkOwner.get("/api/v1/preferences/monitoring").expect(200)).body;
  assert.equal(savedDefaults.notification_mode, "digest");
  assert.equal(savedDefaults.capture_timeout_ms, 90000);
  const timeoutMonitor = (await bulkOwner.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Timeout default fixture", url: "https://example.com/timeout-default", kind: "browser", text_enabled: true, visual_enabled: false, channel_ids: [] }).expect(201)).body;
  assert.equal(timeoutMonitor.capture_timeout_ms, 90000);
  const overrideMonitor = (await bulkOwner.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Timeout override fixture", url: "https://example.com/timeout-override", kind: "browser", text_enabled: true, visual_enabled: false, capture_timeout_ms: 90000, channel_ids: [] }).expect(201)).body;
  assert.equal(overrideMonitor.capture_timeout_ms, 90000);
  const preservedCapture = randomUUID();
  await pool.query("INSERT INTO fusion_captures(id,monitor_id,text_content) VALUES($1,$2,'timeout-history')", [preservedCapture, overrideMonitor.id]);
  await pool.query("UPDATE fusion_monitors SET baseline_id=$2,latest_capture_id=$2 WHERE id=$1", [overrideMonitor.id, preservedCapture]);
  await pool.query("INSERT INTO fusion_events(monitor_id,after_id,status) VALUES($1,$2,'baseline')", [overrideMonitor.id, preservedCapture]);
  const updateBody = { name: "Timeout override fixture", url: "https://example.com/timeout-override", kind: "browser", text_enabled: true, visual_enabled: false, channel_ids: [] };
  const omittedTimeout = (await bulkOwner.put(`/api/v1/jobs/${overrideMonitor.id}`).set("X-Fusion-Request", "1").send(updateBody).expect(200)).body;
  assert.equal(omittedTimeout.capture_timeout_ms, 90000);
  const afterOmission = (await pool.query("SELECT baseline_id,latest_capture_id FROM fusion_monitors WHERE id=$1", [overrideMonitor.id])).rows[0];
  assert.equal(afterOmission.baseline_id, preservedCapture);
  assert.equal(afterOmission.latest_capture_id, preservedCapture);
  const legacyTimeout = (await bulkOwner.put(`/api/v1/jobs/${overrideMonitor.id}`).set("X-Fusion-Request", "1").send({ ...updateBody, capture_timeout_ms: null }).expect(200)).body;
  assert.equal(legacyTimeout.capture_timeout_ms, null);
  const afterLegacy = (await pool.query("SELECT baseline_id,latest_capture_id FROM fusion_monitors WHERE id=$1", [overrideMonitor.id])).rows[0];
  assert.equal(afterLegacy.baseline_id, preservedCapture);
  assert.equal(afterLegacy.latest_capture_id, preservedCapture);
  assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM fusion_events WHERE monitor_id=$1", [overrideMonitor.id])).rows[0].count), 1);
  assert.equal((await bulkOwner.get(`/api/v1/jobs/${overrideMonitor.id}`).expect(200)).body.capture_timeout_ms, null);
  await bulkOwner.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Invalid timeout fixture", url: "https://example.com/timeout-invalid", kind: "browser", text_enabled: true, visual_enabled: false, capture_timeout_ms: 60001, channel_ids: [] }).expect(400);
  await bulkOther.put("/api/v1/preferences/monitoring").set("X-Fusion-Request", "1").send({ channel_ids: [channelId] }).expect(404);
  await bulkOwner.post("/api/v1/monitors/notification-channels/bulk").set("X-Fusion-Request", "1").send({ monitor_ids: [monitor.id], channel_id: channelId, action: "add", confirm: true }).expect(204);
  await bulkOther.post("/api/v1/monitors/notification-channels/bulk").set("X-Fusion-Request", "1").send({ monitor_ids: [monitor.id], channel_id: channelId, action: "remove", confirm: true }).expect(404);
  const association = await pool.query("SELECT 1 FROM fusion_monitor_channels WHERE monitor_id=$1 AND channel_id=$2", [monitor.id, channelId]);
  assert.equal(association.rowCount, 1);
});

test("visual region picker preview maps screenshot coordinates to a unique visible selector without mutating until saved", async (t) => {
  let previewRequests = 0;
  const fixture = managedServer(t, (_req, res) => { previewRequests++; res.end(`<!doctype html><style>body{margin:0}#product{position:absolute;left:100px;top:120px;width:240px;height:80px}#hidden{display:none}</style><main id="product">Selected product</main><div id="hidden">Hidden</div>`); });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const pickerPolicy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const pickerApp = createApp(pool, cfg, pickerPolicy);
  const pickerOwner = request.agent(pickerApp), pickerOther = request.agent(pickerApp);
  for (const [agent, email] of [[pickerOwner, "owner@example.com"], [pickerOther, "other@example.com"]] as const)
    await agent.post("/api/v1/login").set("X-Fusion-Request", "1").send({ email, password }).expect(200);
  const created = (await pickerOwner.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Region fixture", url: `http://fixture.example:${port}/`, kind: "browser", text_enabled: false, visual_enabled: true, capture_mode: "viewport", channel_ids: [] }).expect(201)).body;
  const initial = await pickerOwner.post(`/api/v1/jobs/${created.id}/region-preview`).set("X-Fusion-Request", "1").send({}).expect(200);
  assert.ok(initial.body.image.length > 100);
  assert.equal(initial.body.selection, null);
  const picked = await pickerOwner.post(`/api/v1/jobs/${created.id}/region-preview`).set("X-Fusion-Request", "1").send({ x: 130, y: 150 });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  assert.equal(picked.body.selection.selector, "#product");
  assert.equal((await pickerOwner.get(`/api/v1/jobs/${created.id}`).expect(200)).body.capture_selector, "");
  await pickerOther.post(`/api/v1/jobs/${created.id}/region-preview`).set("X-Fusion-Request", "1").send({}).expect(404);
  await pickerOwner.put(`/api/v1/jobs/${created.id}`).set("X-Fusion-Request", "1").send({ name: "Region fixture", url: `http://fixture.example:${port}/`, kind: "browser", text_enabled: false, visual_enabled: true, capture_mode: "element", capture_selector_type: "css", capture_selector: picked.body.selection.selector, channel_ids: [] }).expect(200);
  assert.equal((await pickerOwner.get(`/api/v1/jobs/${created.id}`).expect(200)).body.capture_selector, "#product");
  await pickerOwner.post(`/api/v1/jobs/${created.id}/region-preview`).set("X-Fusion-Request", "1").send({ x: -1, y: 0 }).expect(422);

  const monitorCount = Number((await pool.query("SELECT count(*)::int AS count FROM fusion_monitors")).rows[0].count);
  const draftPreview = await pickerOwner.post("/api/v1/region-preview").set("X-Fusion-Request", "1").send({
    monitor: { url: `http://fixture.example:${port}/`, kind: "browser", visual_enabled: true, browser_steps: [] },
  }).expect(200);
  assert.match(draftPreview.body.session_id, /^[0-9a-f-]{36}$/);
  const requestsAfterPreview = previewRequests;
  const selectedDraft = await pickerOwner.post("/api/v1/region-preview").set("X-Fusion-Request", "1").send({
    session_id: draftPreview.body.session_id,
    monitor: { url: `http://fixture.example:${port}/`, kind: "browser", visual_enabled: true, browser_steps: [] },
    point: { x: 130, y: 150 },
  }).expect(200);
  assert.equal(selectedDraft.body.selection.selector, "#product");
  assert.equal(previewRequests, requestsAfterPreview, "selection reuses the authenticated draft preview instead of loading the target again");
  assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM fusion_monitors")).rows[0].count), monitorCount);
  await pickerOther.delete(`/api/v1/region-preview/${draftPreview.body.session_id}`).set("X-Fusion-Request", "1").expect(204);
  assert.equal(await acquireChromiumLease(pool, { workload: "preview", slots: 1 }), null, "a foreign release cannot free another owner's Chromium lease");
  await pickerOwner.delete(`/api/v1/region-preview/${draftPreview.body.session_id}`).set("X-Fusion-Request", "1").expect(204);
  await pickerOwner.delete(`/api/v1/region-preview/${draftPreview.body.session_id}`).set("X-Fusion-Request", "1").expect(204);
  const releasedLease = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  assert.ok(releasedLease, "the owner release promptly frees the global Chromium slot");
  await releasedLease!.release();
  const areaPreview = await pickerOwner.post("/api/v1/region-preview").set("X-Fusion-Request", "1").send({
    mode: "area",
    monitor: { url: `http://fixture.example:${port}/`, kind: "browser", visual_enabled: true, browser_steps: [] },
  }).expect(200);
  assert.equal(areaPreview.body.session_id, undefined);
  assert.deepEqual([areaPreview.body.width, areaPreview.body.height], [1280, 900]);
  const areaLease = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  assert.ok(areaLease, "selected-area preview closes Chromium before returning the client-side image");
  await areaLease!.release();

  const denied = await pickerOwner.post("/api/v1/region-preview").set("X-Fusion-Request", "1").send({
    monitor: { url: "http://127.0.0.1/?synthetic_secret=must-not-leak", kind: "browser", visual_enabled: true, browser_steps: [] },
  }).expect(400);
  assert.equal(denied.body.preview_stage, "target_validation");
  assert.equal(denied.body.failure_code, "egress_denied");
  assert.equal(typeof denied.body.request_id, "string");
  assert.equal(typeof denied.body.duration_ms, "number");
  assert.ok(!JSON.stringify(denied.body).includes("synthetic_secret"));

  await pickerOther.post("/api/v1/region-preview").set("X-Fusion-Request", "1").send({
    monitor_id: created.id,
    monitor: { url: `http://fixture.example:${port}/`, kind: "browser", visual_enabled: true, browser_steps: [] },
  }).expect(404);
  await pickerOther.post("/api/v1/region-preview").set("X-Fusion-Request", "1").send({
    session_id: draftPreview.body.session_id,
    monitor: { url: `http://fixture.example:${port}/`, kind: "browser", visual_enabled: true, browser_steps: [] },
    point: { x: 130, y: 150 },
  }).expect(410);
});

test("region preview capacity includes initializing browsers and releases reservations after failures", async (t) => {
  await closeRegionPreviewSessions();
  let blockedRequests = 0;
  let releaseBlocked!: () => void;
  let allStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseBlocked = resolve; });
  const started = new Promise<void>((resolve) => { allStarted = resolve; });
  const fixture = managedServer(t, async (req, res) => {
    if (req.url === "/blocked") {
      blockedRequests++;
      if (blockedRequests === 1) allStarted();
      await blocked;
    }
    if (req.url === "/failure") {
      res.destroy();
      return;
    }
    res.end("<!doctype html><main id='preview-target'>Preview capacity fixture</main>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const monitor = (pathName: string) => ({
    id: randomUUID(),
    url: `http://preview-capacity.example:${port}${pathName}`,
    kind: "browser",
    text_enabled: false,
    visual_enabled: true,
    browser_steps: [],
  }) as any;

  const initializing = Array.from({ length: 1 }, (_, index) =>
    previewRegion(monitor("/blocked"), cfg, undefined, policy, { ownerId: `capacity-owner-${index}`, retain: true }),
  );
  await started;
  assert.equal(blockedRequests, 1, "only one initializing preview reaches navigation");
  await assert.rejects(
    previewRegion(monitor("/blocked"), cfg, undefined, policy, { ownerId: "capacity-owner-excess", retain: true }),
    (error: any) => error.failure_code === "capacity_busy" && error.status === 429,
  );
  assert.equal(blockedRequests, 1, "the rejected preview never launches Chromium or reaches the target");
  releaseBlocked();
  const completed = await Promise.all(initializing);
  assert.equal(completed.length, 1);
  assert.ok(completed.every((entry) => entry.session_id), "admitted previews retain owner-bound sessions");

  await closeRegionPreviewSessions();
  await assert.rejects(
    previewRegion(monitor("/failure"), cfg, undefined, policy, { ownerId: "failure-owner", retain: true }),
    (error: any) => error.stage === "navigation",
  );
  const recovered = await previewRegion(monitor("/success"), cfg, undefined, policy, { ownerId: "recovery-owner", retain: true });
  assert.match(recovered.session_id!, /^[0-9a-f-]{36}$/, "a failed initialization releases its reserved slot");
  await closeRegionPreviewSessions();
});

test("authenticated Preview preempts a real scheduled browser through the same single slot after cleanup", async (t) => {
  let peakTrees = 0;
  let sample: Promise<void> = Promise.resolve();
  let sampling = false;
  const sampleTrees = async () => {
    let trees = 0;
    const pids = (await readdir("/proc")).filter((p) => /^\d+$/.test(p));
    for (let offset = 0; offset < pids.length; offset += 64) await Promise.all(pids.slice(offset, offset + 64).map(async (pid) => {
      try {
        const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
        if (args.includes("--remote-debugging-pipe") && !args.some((a) => a.startsWith("--type="))) trees++;
      } catch { /* process exited between enumeration and inspection */ }
    }));
    peakTrees = Math.max(peakTrees, trees);
  };
  const sampleTimer = setInterval(() => {
    if (!sampling) { sampling = true; sample = sampleTrees().finally(() => { sampling = false; }); }
  }, 20);
  t.after(async () => { clearInterval(sampleTimer); await sample; });
  let started!: () => void;
  const capturing = new Promise<void>((resolve) => { started = resolve; });
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const fixture = managedServer(t, async (req, res) => {
    if (req.url === "/worker") { started(); await gate; }
    res.end("<!doctype html><main id='target'>Single browser handoff fixture</main>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const owner = (await pool.query("SELECT user_id FROM users WHERE email='owner@example.com'")).rows[0].user_id;
  const scheduledMonitor = (await pool.query("INSERT INTO fusion_monitors(user_id,name,url,kind,visual_enabled,text_enabled) VALUES($1,'Handoff fixture',$2,'browser',true,false) RETURNING *", [owner, `http://lane.fixture:${port}/worker`])).rows[0];
  await runMonitor(pool, cfg, scheduledMonitor.id, { force: true, capture: async () => ({ text: null, screenshot: image() }) });
  await pool.query("UPDATE fusion_monitors SET next_run=now()-interval '1 day',failure_count=2,monitor_state='temporary_failure',failure_alert_mode='every',notify_failures=true WHERE id=$1", [scheduledMonitor.id]);
  const notificationChannel = (await pool.query("INSERT INTO fusion_channels(user_id,name,provider,config) VALUES($1,'Handoff notifications','smtp','{}') RETURNING id", [owner])).rows[0].id;
  await pool.query("INSERT INTO fusion_monitor_channels(monitor_id,channel_id) VALUES($1,$2)", [scheduledMonitor.id, notificationChannel]);
  const baselineEvent = (await pool.query("SELECT id FROM fusion_events WHERE monitor_id=$1", [scheduledMonitor.id])).rows[0].id;
  await pool.query("INSERT INTO fusion_outbox(event_id,channel_id,attempts,next_attempt) VALUES($1,$2,1,now()+interval '1 day')", [baselineEvent, notificationChannel]);
  await pool.query("INSERT INTO fusion_notification_digests(monitor_id,channel_id,first_event_at,last_event_at,latest_event_id,due_at) VALUES($1,$2,now(),now(),$3,now()+interval '1 day')", [scheduledMonitor.id, notificationChannel, baselineEvent]);
  const before = (await pool.query("SELECT failure_count,monitor_state,baseline_id,latest_capture_id,last_success_at FROM fusion_monitors WHERE id=$1", [scheduledMonitor.id])).rows[0];
  const outboxForMonitor = () => pool.query("SELECT o.* FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1 ORDER BY o.id", [scheduledMonitor.id]);
  const outbox = (await outboxForMonitor()).rows;
  const digests = (await pool.query("SELECT * FROM fusion_notification_digests WHERE monitor_id=$1", [scheduledMonitor.id])).rows;
  let cleaned = false;
  let workerSignal: AbortSignal | undefined;
  const workerOptions = { stopped: () => cleaned, send: async () => {}, capture: async (m: any, c: any, _policy: any, signal: any) => {
    assert.equal(m.id, scheduledMonitor.id, "the due fixture is selected first");
    workerSignal = signal;
    try { return await capture(m, c, policy, signal); }
    finally { cleaned = true; }
  } };
  const scheduled = workerCycle(pool, cfg, workerOptions);
  const previewApp = createApp(pool, cfg, policy);
  const agent = request.agent(previewApp);
  await agent.post("/api/v1/login").set("X-Fusion-Request", "1").send({ email: "owner@example.com", password }).expect(200);
  try {
    await capturing;
    await sampleTrees();
    const preview = (await agent.post("/api/v1/region-preview").set("X-Fusion-Request", "1").send({ mode: "element", monitor: { url: `http://lane.fixture:${port}/preview`, kind: "browser", visual_enabled: true } }).expect(200)).body;
    assert.ok(preview.image.length > 100);
    await sampleTrees();
    assert.ok(cleaned, "capture cleanup completed before the user browser was admitted");
    assert.ok(workerSignal?.reason instanceof SchedulingCancellation);
    assert.equal(await acquireChromiumLease(pool, { workload: "capture", slots: 3 }), null);
    await scheduled;
    assert.deepEqual((await pool.query("SELECT failure_count,monitor_state,baseline_id,latest_capture_id,last_success_at FROM fusion_monitors WHERE id=$1", [scheduledMonitor.id])).rows[0], before);
    assert.deepEqual((await outboxForMonitor()).rows, outbox);
    assert.deepEqual((await pool.query("SELECT * FROM fusion_notification_digests WHERE monitor_id=$1", [scheduledMonitor.id])).rows, digests);
    const skipped = (await pool.query("SELECT * FROM fusion_events WHERE monitor_id=$1 AND status='skipped'", [scheduledMonitor.id])).rows;
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].warning_code, "interactive_priority");
    assert.equal(skipped[0].after_id, null);
    await agent.get(`/api/v1/jobs/${scheduledMonitor.id}/history?status=skipped`).expect(200);
    await closeRegionPreviewSessions();
    unblock();
    cleaned = false;
    await pool.query("UPDATE fusion_monitors SET next_run=now()-interval '1 day' WHERE id=$1", [scheduledMonitor.id]);
    await workerCycle(pool, cfg, workerOptions);
    assert.equal((await pool.query("SELECT failure_count FROM fusion_monitors WHERE id=$1", [scheduledMonitor.id])).rows[0].failure_count, 0, "normal scheduled capture resumes successfully after Preview cleanup");
    await sample;
    assert.equal(peakTrees, 1, "real sandboxed Chromium roots never overlap during handoff");
  } finally { unblock(); await scheduled; await closeRegionPreviewSessions(); }
});

test("manual Check Now is durable, deduplicated, owner-bound and completed atomically by a restarted Worker", async (t) => {
  let navigationStarted!: () => void;
  const navigating = new Promise<void>((resolve) => { navigationStarted = resolve; });
  const fixture = managedServer(t, (req, res) => {
    if (req.url === "/blocked") { navigationStarted(); return; }
    res.end("<main>Manual priority fixture</main>");
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const owner = (await pool.query("SELECT user_id FROM users WHERE email='owner@example.com'")).rows[0].user_id;
  const m = (await pool.query("INSERT INTO fusion_monitors(user_id,name,url,kind,visual_enabled,text_enabled,next_run) VALUES($1,'Manual fixture',$2,'browser',true,false,now()+interval '1 day') RETURNING *", [owner, `http://manual.fixture:${port}`])).rows[0];
  t.after(async () => {
    const open = await pool.query("UPDATE fusion_manual_runs SET status='cancelled',updated_at=now() WHERE monitor_id=$1 AND status IN ('queued','running') RETURNING priority_intent_id", [m.id]);
    for (const run of open.rows) await cancelInteractivePriorityIntent(pool, run.priority_intent_id);
  });
  const scheduled = await acquireChromiumLease(pool, { workload: "capture", slots: 1, observeInteractivePriority: true });
  assert.ok(scheduled);
  t.after(() => scheduled.release());
  const interrupted = capture({ ...m, url: `http://manual.fixture:${port}/blocked` }, cfg, policy, scheduled.signal).then(() => null, (error) => error);
  await navigating;
  const queued = (await ownerAgent.post(`/api/v1/jobs/${m.id}/run`).set("X-Fusion-Request", "1").send({}).expect(202)).body;
  const duplicate = (await ownerAgent.post(`/api/v1/jobs/${m.id}/run`).set("X-Fusion-Request", "1").send({}).expect(202)).body;
  assert.equal(duplicate.request_id, queued.request_id);
  await otherAgent.get(`/api/v1/jobs/${m.id}/run`).expect(404);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(scheduled.signal?.reason instanceof SchedulingCancellation, "explicit Check Now requests cooperative preemption");
  assert.ok(await interrupted instanceof SchedulingCancellation, "real active Chromium work yields to Check Now");
  await scheduled.release();
  // Simulate a Worker death before launch: the durable running record is picked
  // up by a replacement cycle and the per-monitor advisory lock prevents duplicates.
  await pool.query("UPDATE fusion_manual_runs SET status='running' WHERE id=$1", [queued.request_id]);
  await pool.query("UPDATE fusion_chromium_priority_intents SET created_at=now()-interval '30 seconds',expires_at=now()-interval '10 seconds' WHERE id=(SELECT priority_intent_id FROM fusion_manual_runs WHERE id=$1)", [queued.request_id]);
  let calls = 0;
  const options = { capture: async (monitor: any, config: any, _policy: any, signal: any) => {
    if (monitor.id !== m.id) return { text: "fixture", screenshot: monitor.visual_enabled ? image() : null };
    calls++;
    return capture(monitor, config, policy, signal);
  }, send: async () => {} };
  await Promise.all([workerCycle(pool, cfg, options), workerCycle(pool, cfg, options)]);
  // A non-blocking probe can race another replica's brief admission transaction.
  // Model the real Worker loop's subsequent bounded cycles, without allowing
  // duplicate captures or weakening the completed-state assertion below.
  for (let attempt = 0; calls === 0 && attempt < 3; attempt++)
    await workerCycle(pool, cfg, options);
  assert.equal(calls, 1, "two replacement Workers cannot duplicate the manual capture");
  assert.equal((await ownerAgent.get(`/api/v1/jobs/${m.id}/run`).expect(200)).body.status, "completed");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_captures WHERE monitor_id=$1", [m.id])).rows[0].n, 1);
  await pool.query("UPDATE fusion_monitors SET kind='html',visual_enabled=false,text_enabled=true WHERE id=$1", [m.id]);
  await ownerAgent.post(`/api/v1/jobs/${m.id}/run`).set("X-Fusion-Request", "1").send({}).expect(202);
  await workerCycle(pool, cfg, { capture: async () => { throw new CaptureFailure("navigation", "connection_failure"); }, send: async () => {} });
  assert.equal((await ownerAgent.get(`/api/v1/jobs/${m.id}/run`).expect(200)).body.status, "failed", "genuine non-browser errors retain failure semantics");
  const health = (await pool.query("SELECT failure_count,monitor_state,baseline_id,latest_capture_id FROM fusion_monitors WHERE id=$1", [m.id])).rows[0];
  await ownerAgent.post(`/api/v1/jobs/${m.id}/run`).set("X-Fusion-Request", "1").send({}).expect(202);
  await ownerAgent.delete(`/api/v1/jobs/${m.id}/run`).set("X-Fusion-Request", "1").expect(204);
  assert.equal((await ownerAgent.get(`/api/v1/jobs/${m.id}/run`).expect(200)).body.status, "cancelled");
  assert.deepEqual((await pool.query("SELECT failure_count,monitor_state,baseline_id,latest_capture_id FROM fusion_monitors WHERE id=$1", [m.id])).rows[0], health);
});

test("another replica cannot cancel a disabled running manual request before its monitor lock is released", async () => {
  const created = (await ownerAgent.post("/api/v1/jobs").set("X-Fusion-Request", "1").send({ name: "Disabled running manual fixture", url: "https://example.com/disabled-manual", kind: "html", text_enabled: true, visual_enabled: false }).expect(201)).body;
  const queued = (await ownerAgent.post(`/api/v1/jobs/${created.id}/run`).set("X-Fusion-Request", "1").expect(202)).body;
  await pool.query("UPDATE fusion_manual_runs SET status='running' WHERE id=$1", [queued.request_id]);
  await pool.query("UPDATE fusion_monitors SET enabled=false WHERE id=$1", [created.id]);
  const active = await pool.connect();
  try {
    await active.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [created.id]);
    await workerCycle(pool, cfg, { stopped: () => true });
    assert.equal((await pool.query("SELECT status FROM fusion_manual_runs WHERE id=$1", [queued.request_id])).rows[0].status, "running");
  } finally { await active.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [created.id]); active.release(); }
  await workerCycle(pool, cfg, { stopped: () => true });
  assert.equal((await pool.query("SELECT status FROM fusion_manual_runs WHERE id=$1", [queued.request_id])).rows[0].status, "cancelled");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_events WHERE monitor_id=$1", [created.id])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT failure_count FROM fusion_monitors WHERE id=$1", [created.id])).rows[0].failure_count, 0);
});

test("manual queue bounds apply atomically without creating priority for rejected requests", async () => {
  const owner = (await pool.query("SELECT user_id FROM users WHERE email='owner@example.com'")).rows[0].user_id;
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) ids.push((await pool.query("INSERT INTO fusion_monitors(user_id,name,url,kind,next_run) VALUES($1,'Bounded manual queue','https://example.com','html',now()+interval '1 day') RETURNING id", [owner])).rows[0].id);
  try {
    await Promise.all(ids.slice(0, 4).map((id) => ownerAgent.post(`/api/v1/jobs/${id}/run`).set("X-Fusion-Request", "1").send({}).expect(202)));
    const intents = (await pool.query("SELECT count(*)::int AS n FROM fusion_chromium_priority_intents")).rows[0].n;
    await ownerAgent.post(`/api/v1/jobs/${ids[4]}/run`).set("X-Fusion-Request", "1").send({}).expect(429);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_chromium_priority_intents")).rows[0].n, intents);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_manual_runs WHERE monitor_id=ANY($1::uuid[]) AND status='queued'", [ids])).rows[0].n, 4);
  } finally {
    for (const id of ids) await ownerAgent.delete(`/api/v1/jobs/${id}/run`).set("X-Fusion-Request", "1").expect(204);
  }
});

test("browser contention defers due work without starving non-browser checks or flooding history", async () => {
  const owner = (await pool.query("SELECT user_id FROM users WHERE email='owner@example.com'")).rows[0].user_id;
  const browserIds: string[] = [];
  for (let index = 0; index < 6; index++) browserIds.push((await pool.query("INSERT INTO fusion_monitors(user_id,name,url,kind,next_run) VALUES($1,'Deferred browser','https://example.com','browser',now()-interval '10 days') RETURNING id", [owner])).rows[0].id);
  const html = (await pool.query("INSERT INTO fusion_monitors(user_id,name,url,kind,next_run) VALUES($1,'Unblocked HTML','https://example.com','html',now()-interval '9 days') RETURNING id", [owner])).rows[0].id;
  const held = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  assert.ok(held);
  let calls = 0;
  const options = { stopped: () => calls > 0, capture: async (m: any) => { assert.equal(m.id, html); calls++; return { text: "fixture", screenshot: null }; }, send: async () => {} };
  try {
    await workerCycle(pool, cfg, options);
    await workerCycle(pool, cfg, options);
    assert.equal(calls, 1, "the next due batch reaches non-browser checks during interactive contention");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_events WHERE monitor_id=ANY($1::uuid[])", [browserIds])).rows[0].n, 0, "work that never started does not generate skipped history");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_monitors WHERE id=ANY($1::uuid[]) AND next_run>now()", [browserIds])).rows[0].n, 6);
  } finally { await held.release(); await pool.query("UPDATE fusion_monitors SET enabled=false WHERE id=ANY($1::uuid[])", [[...browserIds, html]]); }
});

test("priority intents expire, remain bounded and repeated reconnects give scheduled work a recovery turn", async () => {
  const owner = (await pool.query("SELECT user_id FROM users WHERE email='owner@example.com'")).rows[0].user_id;
  await pool.query("UPDATE fusion_chromium_scheduler SET priority_window_until=NULL,scheduled_turn_until=NULL WHERE id=1");
  const intent = await createInteractivePriorityIntent(pool, owner, "preview");
  await assert.rejects(createInteractivePriorityIntent(pool, owner, "preview"), (e: any) => e.code === "capacity_queue_full");
  assert.equal(await acquireChromiumLease(pool, { workload: "capture", slots: 1 }), null, "pending scheduled work is deferred without starting a browser");
  await pool.query("UPDATE fusion_chromium_priority_intents SET created_at=now()-interval '30 seconds',expires_at=now()-interval '10 seconds' WHERE id=$1", [intent]);
  const recovered = await acquireChromiumLease(pool, { workload: "capture", slots: 1 });
  assert.ok(recovered); await recovered.release();
  await pool.query("UPDATE fusion_chromium_scheduler SET priority_window_until=now()-interval '1 second' WHERE id=1");
  await assert.rejects(createInteractivePriorityIntent(pool, owner, "preview"), (e: any) => e.code === "scheduled_recovery");
  await assert.rejects(createInteractivePriorityIntent(pool, owner, "preview"), (e: any) => e.code === "scheduled_recovery");
  const fair = await acquireChromiumLease(pool, { workload: "capture", slots: 1, observeInteractivePriority: true });
  assert.ok(fair);
  await pool.query("UPDATE fusion_chromium_scheduler SET scheduled_turn_until=now()-interval '1 second' WHERE id=1");
  const afterTurn = await createInteractivePriorityIntent(pool, owner, "preview");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fair.signal?.aborted, false, "a recovery capture retains its bounded capture deadline even after the admission turn ends");
  await fair.release();
  await cancelInteractivePriorityIntent(pool, afterTurn);
  await cancelInteractivePriorityIntent(pool, intent);
  await pool.query("UPDATE fusion_chromium_scheduler SET priority_window_until=NULL,scheduled_turn_until=NULL WHERE id=1");
});

test("an active Preview cannot reset an expired burst through quiet reconnects and already-running scheduled recovery completes", async () => {
  const owner = (await pool.query("SELECT user_id FROM users WHERE email='owner@example.com'")).rows[0].user_id;
  const reset = () => pool.query("UPDATE fusion_chromium_scheduler SET priority_window_until=NULL,last_interactive_at=NULL,scheduled_turn_until=NULL,scheduled_recovery_pending=false WHERE id=1");
  await reset();
  let held = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  let intent: string | undefined;
  try {
    assert.ok(held);
    await pool.query("UPDATE fusion_chromium_scheduler SET priority_window_until=now()-interval '1 second',last_interactive_at=now()-interval '31 seconds' WHERE id=1");
    await assert.rejects(createInteractivePriorityIntent(pool, owner, "preview"), (e: any) => e.code === "scheduled_recovery");
    const pending = (await pool.query("SELECT scheduled_recovery_pending,scheduled_turn_until FROM fusion_chromium_scheduler WHERE id=1")).rows[0];
    assert.equal(pending.scheduled_recovery_pending, true);
    assert.equal(pending.scheduled_turn_until, null, "the recovery admission window starts only after confirmed Preview cleanup");
    await held.release(); held = null;
    const released = (await pool.query("SELECT scheduled_turn_until>now() AS turn,last_interactive_at>now()-interval '1 second' AS recent FROM fusion_chromium_scheduler WHERE id=1")).rows[0];
    assert.deepEqual(released, { turn: true, recent: true });
    await reset();
    held = await acquireChromiumLease(pool, { workload: "capture", slots: 1, observeInteractivePriority: true });
    assert.ok(held);
    await pool.query("UPDATE fusion_chromium_scheduler SET priority_window_until=now()-interval '1 second',last_interactive_at=now() WHERE id=1");
    await assert.rejects(createInteractivePriorityIntent(pool, owner, "preview"), (e: any) => e.code === "scheduled_recovery");
    await new Promise(resolve => setTimeout(resolve, 250));
    await pool.query("UPDATE fusion_chromium_scheduler SET scheduled_turn_until=now()-interval '1 second' WHERE id=1");
    intent = await createInteractivePriorityIntent(pool, owner, "preview");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(held.signal!.aborted, false, "a scheduled capture already running when recovery began retains its bounded deadline");
  } finally { await held?.release(); await cancelInteractivePriorityIntent(pool, intent); await reset(); }
});

test("scheduled cancellation during real Browser Steps and stalled screenshot closes Chromium before releasing capacity", async (t) => {
  const { chromium } = await import("playwright");
  for (const stage of ["steps", "screenshot"] as const) {
    let entered!: () => void;
    const active = new Promise<void>((resolve) => { entered = resolve; });
    const fixture = managedServer(t, (req, res) => {
      if (req.url === "/entered") entered();
      res.end('<button id="start" onclick="fetch(\'/entered\')">Start</button><main>Capture fixture</main>');
    });
    await listenServer(fixture);
    const port = (fixture.address() as AddressInfo).port;
    const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
    const launch = chromium.launch.bind(chromium);
    const launchMock = mock.method(chromium, "launch", async (options) => {
      const browser = await launch(options);
      if (stage === "screenshot") {
        const newContext = browser.newContext.bind(browser);
        mock.method(browser, "newContext", async (options) => {
          const context = await newContext(options);
          const newSession = context.newCDPSession.bind(context);
          mock.method(context, "newCDPSession", async (page) => {
            const session = await newSession(page);
            const send = session.send.bind(session) as any;
            mock.method(session, "send", (async (method: string, args: any) => {
              if (method === "Page.captureScreenshot") {
                entered();
                // Real CDP work deliberately remains pending until context/browser
                // close, exercising the same cancellation and cleanup path.
                return send("Runtime.evaluate", { expression: "new Promise(()=>{})", awaitPromise: true });
              }
              return send(method, args);
            }) as any);
            return session;
          });
          return context;
        });
      }
      return browser;
    });
    const lease = await acquireChromiumLease(pool, { workload: "capture", slots: 1 });
    assert.ok(lease);
    const controller = new AbortController();
    const m = { id: randomUUID(), url: `http://cancel.fixture:${port}`, kind: "browser", text_enabled: false, visual_enabled: true, capture_mode: "viewport", mask_selectors: [], ignore_selectors: [], ignore_text: [], browser_steps: stage === "steps" ? [{ action: "click", selector: "#start", timeout_ms: 10_000 }, { action: "wait_visible", selector: "#never", timeout_ms: 60_000 }]: [], step_budget_ms: 60_000 } as any;
    const result = capture(m, cfg, policy, AbortSignal.any([controller.signal, lease.signal!])).then(() => null, (e) => e);
    try {
      await active;
      controller.abort(new SchedulingCancellation());
      assert.ok(await result instanceof SchedulingCancellation);
      assert.equal(await acquireChromiumLease(pool, { workload: "preview", slots: 1 }), null, "confirmed cleanup does not itself release the owner's reservation early");
      await lease.release();
      const next = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
      assert.ok(next); await next.release();
    } finally { controller.abort(new SchedulingCancellation()); await result; await lease.release(); launchMock.mock.restore(); }
  }
});

test("cancellation rolls back capture commit preparation but cannot retroactively skip a committed success", async () => {
  const owner = (await pool.query("SELECT user_id FROM users WHERE email='owner@example.com'")).rows[0].user_id;
  for (const boundary of ["before_commit", "after_commit"]) {
    const m = (await pool.query("INSERT INTO fusion_monitors(user_id,name,url,kind,visual_enabled,text_enabled) VALUES($1,'Commit boundary fixture','https://example.com','browser',false,true) RETURNING *", [owner])).rows[0];
    await runMonitor(pool, cfg, m.id, { force: true, capture: async () => ({ text: "before", screenshot: null }) });
    await pool.query("UPDATE fusion_monitors SET failure_count=2,monitor_state='temporary_failure' WHERE id=$1", [m.id]);
    const baseline = (await pool.query("SELECT baseline_id FROM fusion_monitors WHERE id=$1", [m.id])).rows[0].baseline_id;
    const controller = new AbortController();
    const wrapped = { connect: async () => {
      const c = await pool.connect();
      return { query: async (sql: string, values: any[]) => {
        const r = await c.query(sql, values);
        if ((boundary === "before_commit" && sql.includes("SET latest_capture_id=")) || (boundary === "after_commit" && sql === "COMMIT")) controller.abort(new SchedulingCancellation());
        return r;
      }, release: c.release.bind(c) };
    } } as any;
    await runMonitor(wrapped, cfg, m.id, { force: true, signal: controller.signal, capture: async () => ({ text: "after", screenshot: null }) });
    const current = (await pool.query("SELECT * FROM fusion_monitors WHERE id=$1", [m.id])).rows[0];
    const events = (await pool.query("SELECT status FROM fusion_events WHERE monitor_id=$1 ORDER BY created_at", [m.id])).rows.map((e) => e.status);
    assert.deepEqual(events, ["baseline", boundary === "before_commit" ? "skipped" : "changed"]);
    assert.equal(current.failure_count, boundary === "before_commit" ? 2 : 0);
    assert.equal(current.baseline_id === baseline, boundary === "before_commit");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_captures WHERE monitor_id=$1", [m.id])).rows[0].n, boundary === "before_commit" ? 1 : 2);
  }
});

test("database session loss aborts a resident browser and permits lane recovery", async (t) => {
  const fixture = managedServer(t, (_req, res) => res.end("<!doctype html><main>Lease recovery fixture</main>"));
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  let lease: Awaited<ReturnType<typeof acquireChromiumLease>>;
  const monitor = { id: randomUUID(), url: `http://lease.fixture:${port}/`, kind: "browser", visual_enabled: true, text_enabled: false, browser_steps: [] } as any;
  try {
    const preview = await previewRegion(monitor, cfg, undefined, policy, { ownerId: "crash-recovery-owner", retain: true, acquireCapacity: async () => lease = await acquireChromiumLease(pool, { workload: "preview", slots: 1 }) });
    const locks = await pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND objid=1 AND granted", [0x43484645]);
    assert.equal(locks.rowCount, 1);
    await pool.query("SELECT pg_terminate_backend($1)", [locks.rows[0].pid]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(lease!.signal!.aborted);
    await closeRegionPreviewSessions();
    await assert.rejects(previewRegion(monitor, cfg, undefined, policy, { ownerId: "crash-recovery-owner", id: preview.session_id }), (e: any) => e.failure_code === "session_expired");
    const recovered = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
    assert.ok(recovered); await recovered.release();
  } finally { await closeRegionPreviewSessions(); }
});

test("an unexpectedly unlocked advisory session aborts real Preview while its durable fence prevents overlap", async (t) => {
  const fixture = managedServer(t, (_req, res) => res.end("<main>Unexpected unlock fixture</main>"));
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const leaseClient = await pool.connect();
  const leasePool = { connect: async () => leaseClient, query: pool.query.bind(pool) } as unknown as Pool;
  let lease: Awaited<ReturnType<typeof acquireChromiumLease>>;
  let allowRelease!: () => void;
  const releaseGate = new Promise<void>(resolve => { allowRelease = resolve; });
  try {
    await previewRegion({ id: randomUUID(), url: `http://unlock.fixture:${port}/`, kind: "browser", visual_enabled: true, text_enabled: false, browser_steps: [] } as any, cfg, undefined, policy, {
      ownerId: "unlock-owner", retain: true, acquireCapacity: async () => {
        lease = await acquireChromiumLease(leasePool, { workload: "preview", slots: 1 });
        return lease && { ...lease, release: async () => { await releaseGate; await lease!.release(); } };
      },
    });
    await leaseClient.query("SELECT pg_advisory_unlock_all()");
    // Before the owner's explicit release, its durable token protects handoff
    // despite an otherwise available PostgreSQL session lock.
    await assert.rejects(acquireChromiumLease(pool, { workload: "capture", slots: 1 }), (e: any) => e.code === "cleanup_timeout");
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.ok(lease!.signal!.aborted);
    allowRelease();
    await closeRegionPreviewSessions();
    const recovered = await acquireChromiumLease(pool, { workload: "capture", slots: 1 });
    assert.ok(recovered); await recovered.release();
  } finally { allowRelease(); await closeRegionPreviewSessions(); }
});

test("lease-only API and Worker process crashes quarantine capacity until cleanup has been independently confirmed", async () => {
  for (const workload of ["preview", "capture"] as const) {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import {makePool} from './src/db.ts';
      import {acquireChromiumLease} from './src/chromium-capacity.ts';
      const pool=makePool(process.env.TEST_DATABASE_URL);
      const lease=await acquireChromiumLease(pool,{workload:'${workload}',slots:1});
      if(!lease)process.exit(2);
      console.log('ready');setInterval(()=>{},1000);
    `], { env: { ...process.env, TEST_DATABASE_URL: cfg.DATABASE_URL }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("Lease subprocess did not start")), 5000);
        child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
        child.once("error", (e) => { clearTimeout(timer); reject(e); });
        child.once("exit", () => { clearTimeout(timer); reject(Error("Lease subprocess exited early")); });
      });
      const busy = await acquireChromiumLease(pool, { workload, slots: 1 });
      if (busy) await busy.release();
      assert.equal(busy, null);
      await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
      await assert.rejects(acquireChromiumLease(pool, { workload, slots: 1 }), (error: any) => error.code === "cleanup_timeout");
      // This subprocess intentionally never launched Chromium. The test can
      // independently confirm cleanup; production must not clear on timeout.
      const token = (await pool.query("SELECT active_token FROM fusion_chromium_scheduler WHERE id=1")).rows[0].active_token;
      await recoverChromiumQuarantine(pool, token, async () => {
        assert.ok(child.signalCode === "SIGKILL", "this fixture owned only a lease and launched no browser");
      });
      const recovered = await acquireChromiumLease(pool, { workload, slots: 1 });
      assert.ok(recovered, `${workload} resumes only after confirmed recovery`);
      await recovered.release();
    } finally { child.kill("SIGKILL"); }
  }
});

test("offline recovery rejects live/legacy owners, changed tokens and failed fencing without touching monitor or notification state", async () => {
  const snapshot = async () => (await pool.query("SELECT (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM fusion_monitors m) AS monitors,(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM fusion_manual_runs r) AS manual,(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM fusion_outbox o) AS outbox,(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM fusion_events e) AS events")).rows[0];
  const before = await snapshot();
  const held = await acquireChromiumLease(pool, { workload: "capture", slots: 1 });
  assert.ok(held);
  const heldToken = (await pool.query("SELECT active_token FROM fusion_chromium_scheduler WHERE id=1")).rows[0].active_token;
  await assert.rejects(recoverChromiumQuarantine(pool, heldToken, async () => {}), /still connected/);
  await held.release();
  const token = randomUUID();
  // No browser is launched in this transaction/fencing contract test.
  await pool.query("UPDATE fusion_chromium_scheduler SET active_token=$1,active_workload='capture',active_since=now() WHERE id=1", [token]);
  let verified = 0;
  await assert.rejects(recoverChromiumQuarantine(pool, randomUUID(), async () => { verified++; }), /token changed/);
  assert.equal(verified, 0);
  await assert.rejects(recoverChromiumQuarantine(pool, token, async () => { throw Error("Unproven process death"); }), /Unproven/);
  const legacy = await pool.connect();
  try {
    await legacy.query("SELECT pg_advisory_lock($1,4)", [0x43484645]);
    await assert.rejects(recoverChromiumQuarantine(pool, token, async () => { verified++; }), /still connected/);
    assert.equal(verified, 0);
  } finally { await legacy.query("SELECT pg_advisory_unlock($1,4)", [0x43484645]); legacy.release(); }
  assert.equal((await pool.query("SELECT active_token FROM fusion_chromium_scheduler WHERE id=1")).rows[0].active_token, token);
  await recoverChromiumQuarantine(pool, token, async () => { verified++; });
  assert.equal(verified, 1);
  assert.deepEqual(await snapshot(), before);
  const recovered = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  assert.ok(recovered); await recovered.release();
});

test("PostgreSQL Chromium admission coordinates preview and scheduled capture leases", async () => {
  const preview = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  assert.ok(preview, "first preview reserves the cross-process interactive slot");
  assert.equal(await acquireChromiumLease(pool, { workload: "preview", slots: 1 }), null, "excess preview is rejected before browser launch");
  const waitingCapture = acquireChromiumLease(pool, { workload: "capture", slots: 1, waitMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await acquireChromiumLease(pool, { workload: "preview", slots: 1 }), null, "a second preview cannot exceed the reserved interactive slot");
  await preview!.release();
  const captureLease = await waitingCapture;
  assert.ok(captureLease, "scheduled capture uses the same shared slot");
  const recovered = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  assert.equal(recovered, null, "preview cannot overlap an active capture");
  assert.equal(await acquireChromiumLease(pool, { workload: "capture", slots: 3, waitMs: 0 }), null, "replicas and larger slot settings cannot exceed the fixed scheduled limit");
  await captureLease!.release();
});

test("waiting previews release PostgreSQL clients between probes and acquire after interactive work", async () => {
  const capture = await acquireChromiumLease(pool, { workload: "preview", slots: 1, waitMs: 0 });
  assert.ok(capture);
  const controller = new AbortController();
  let waits = 0;
  const queued = acquireChromiumLease(pool, {
    // The configured admission window is long enough for a representative
    // scheduled capture; this controlled release keeps the CI test bounded.
    workload: "preview", slots: 1, waitMs: 1000, signal: controller.signal,
    onWait: () => { waits++; },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(waits > 0, "preview reports bounded capacity waiting without starting Chromium");
  await capture!.release();
  const preview = await queued;
  assert.ok(preview, "preview acquires the released slot automatically");
  await preview!.release();

  const held = await acquireChromiumLease(pool, { workload: "preview", slots: 1, waitMs: 0 });
  assert.ok(held);
  const cancelled = acquireChromiumLease(pool, { workload: "preview", slots: 1, waitMs: 1_000, signal: controller.signal });
  controller.abort();
  assert.equal(await cancelled, null, "cancelled preview waiting does not retain a lease");
  await held!.release();
});

test("preview browser execution receives its full deadline after bounded admission", async (t) => {
  await closeRegionPreviewSessions();
  const fixture = managedServer(t, (_req, res) => res.end("<!doctype html><main id='preview-target'>Admission budget fixture</main>"));
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const delayedAdmissionMs = 3_500;
  const executionCfg = { ...cfg, CAPTURE_TIMEOUT_MS: 4_000 };
  const monitor = { id: randomUUID(), url: `http://preview-budget.example:${port}/`, kind: "browser", text_enabled: false, visual_enabled: true, browser_steps: [] } as any;
  const preview = await previewRegion(monitor, executionCfg, undefined, policy, {
    ownerId: "execution-budget-owner",
    acquireCapacity: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayedAdmissionMs));
      return acquireChromiumLease(pool, { workload: "preview", slots: 1 });
    },
  });
  assert.ok(preview.image.length > 100, "browser work succeeds with its complete post-admission deadline");
  await closeRegionPreviewSessions();
});

test("preview sessions have an absolute lifetime despite repeated selections and free scheduled capture capacity", async (t) => {
  await closeRegionPreviewSessions();
  const fixture = managedServer(t, (_req, res) => res.end("<!doctype html><main id='preview-target' style='position:absolute;left:100px;top:100px;width:200px;height:80px'>Bounded session</main>"));
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const monitor = { id: randomUUID(), url: `http://preview-lifetime.example:${port}/`, kind: "browser", text_enabled: false, visual_enabled: true, browser_steps: [] } as any;
  const acquireCapacity = () => acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  const preview = await previewRegion(monitor, cfg, undefined, policy, { ownerId: "absolute-lifetime-owner", retain: true, acquireCapacity });
  await previewRegion(monitor, cfg, { x: 120, y: 120 }, policy, { ownerId: "absolute-lifetime-owner", id: preview.session_id, retain: true });
  await previewRegion(monitor, cfg, { x: 120, y: 120 }, policy, { ownerId: "absolute-lifetime-owner", id: preview.session_id, retain: true });
  assert.equal(await acquireChromiumLease(pool, { workload: "preview", slots: 1, waitMs: 0 }), null, "resident preview holds its interactive slot only until its absolute expiry");
  await expireRegionPreviewSessions(Date.now() + REGION_PREVIEW_MAX_LIFETIME_MS + 1);
  const scheduled = await acquireChromiumLease(pool, { workload: "preview", slots: 1, waitMs: 100 });
  assert.ok(scheduled, "absolute expiry releases capacity for a scheduled capture after repeated selections");
  await scheduled!.release();
  await closeRegionPreviewSessions();
});

test("region preview bounds slow resources, resolves deep DOM selectors and rejects screenshot drift", async (t) => {
  await closeRegionPreviewSessions();
  let documentRequests = 0;
  const fixture = managedServer(t, async (req, res) => {
    if (req.url === "/slow-font.woff2" || req.url === "/slow-image.png") {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      res.writeHead(404).end();
      return;
    }
    documentRequests++;
    const drifting = req.url === "/drift";
    const ancestorDrift = req.url === "/ancestor-drift";
    const nested = `<div class="level"><div class="level"><div class="level"><div class="level"><div class="level"><div class="level"><div class="level"><span class="target">Requested content</span></div></div></div></div></div></div></div>`;
    res.end(`<!doctype html><style>@font-face{font-family:slow;src:url('/slow-font.woff2')}body{margin:0;font-family:slow}.level{display:block;padding:3px}.target{display:block;width:160px;height:40px}#root,.other{width:240px;height:120px}#root{position:absolute;left:100px;top:120px}.other{position:absolute;left:500px;top:120px}</style><div id="root">${nested}</div><div class="other">${nested}</div><img src="/slow-image.png">${drifting ? `<script>setTimeout(()=>document.querySelector('#root').style.left='180px',2000)</script>` : ""}${ancestorDrift ? `<script>setTimeout(()=>document.querySelector('#root').style.width='400px',2000)</script>` : ""}`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const monitorFor = (pathName: string) => ({ id: randomUUID(), url: `http://preview-performance.example:${port}${pathName}`, kind: "browser", text_enabled: false, visual_enabled: true, browser_steps: [] }) as any;
  const { chromium: playwrightChromium } = await import("playwright");
  const legacyStarted = performance.now();
  const legacyBrowser = await playwrightChromium.launch({ headless: true, chromiumSandbox: true, executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH });
  const legacyPage = await legacyBrowser.newPage({ viewport: { width: 1280, height: 900 } });
  await legacyPage.goto(`http://127.0.0.1:${port}/stable`, { waitUntil: "domcontentloaded" });
  await legacyPage.screenshot({ type: "png" });
  await legacyBrowser.close();
  const legacyMs = performance.now() - legacyStarted;
  const started = performance.now();
  const preview = await previewRegion(monitorFor("/stable"), cfg, undefined, policy, { ownerId: "performance-owner", retain: true });
  const coldMs = performance.now() - started;
  assert.ok(coldMs < 5000, `bounded preview should finish before slow optional resources (${Math.round(coldMs)}ms)`);
  assert.ok(coldMs < legacyMs, `optimized ${Math.round(coldMs)}ms should beat legacy screenshot wait ${Math.round(legacyMs)}ms`);
  assert.ok(preview.timings?.rendering_preparation! <= 1800, JSON.stringify(preview.timings));
  const requestsAfterPreview = documentRequests;
  const reuseStarted = performance.now();
  const selected = await previewRegion(monitorFor("/stable"), cfg, { x: 130, y: 150 }, policy, { ownerId: "performance-owner", id: preview.session_id, retain: true });
  const reuseMs = performance.now() - reuseStarted;
  assert.ok(reuseMs < 1000, "selection reuses the loaded DOM");
  t.diagnostic(`preview timing ms: legacy=${Math.round(legacyMs)} optimized=${Math.round(coldMs)} reuse=${Math.round(reuseMs)} stages=${JSON.stringify(preview.timings)}`);
  assert.equal(documentRequests, requestsAfterPreview);
  assert.match(selected.selection?.selector ?? "", /^#root/);
  assert.ok((selected.selection?.selector.match(/ > /g) ?? []).length > 6, "selector traversal is not limited to six levels");
  assert.ok((selected.candidates?.length ?? 0) >= 2, "nested parent boundaries are available without another navigation");

  await closeRegionPreviewSessions();
  const drift = await previewRegion(monitorFor("/drift"), cfg, undefined, policy, { ownerId: "drift-owner", retain: true });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await assert.rejects(previewRegion(monitorFor("/drift"), cfg, { x: 210, y: 150 }, policy, { ownerId: "drift-owner", id: drift.session_id, retain: true }), (error: any) => error.status === 409 && error.failure_code === "stale_preview");
  const requestsBeforeRefresh = documentRequests;
  const refreshed = await previewRegion(monitorFor("/drift"), cfg, { x: 210, y: 150 }, policy, { ownerId: "drift-owner", id: drift.session_id, retain: true, refresh: true });
  assert.ok(refreshed.selection?.selector, "stale selection can refresh screenshot and DOM metadata in the existing session");
  assert.equal(documentRequests, requestsBeforeRefresh, "selection refresh does not navigate the target again");
  await closeRegionPreviewSessions();
  const ancestor = await previewRegion(monitorFor("/ancestor-drift"), cfg, undefined, policy, { ownerId: "ancestor-drift-owner", retain: true });
  await new Promise((resolve) => setTimeout(resolve, 2200));
  const stillAccurate = await previewRegion(monitorFor("/ancestor-drift"), cfg, { x: 130, y: 150 }, policy, { ownerId: "ancestor-drift-owner", id: ancestor.session_id, retain: true });
  assert.ok(stillAccurate.selection?.selector, "unrelated ancestor resizing does not invalidate the unchanged exact target");
  await closeRegionPreviewSessions();
});

test("region preview applies the validated browser workflow before its screenshot", async (t) => {
  await closeRegionPreviewSessions();
  const fixture = managedServer(t, (_req, res) => res.end(`<!doctype html><style>#cookie{position:fixed;inset:0;background:#000;color:#fff}#target{position:absolute;left:100px;top:120px;width:240px;height:80px;background:#0f0}</style><div id="cookie">Cookie notice <button id="dismiss" onclick="document.querySelector('#cookie').remove()">Dismiss</button></div><main id="target">Visible product</main>`));
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const monitored = {
    id: randomUUID(), url: `http://preview-steps.example:${port}/`, kind: "browser", text_enabled: false, visual_enabled: true,
    browser_steps: [{ action: "dismiss_cookie", selector: "#dismiss", selector_type: "css", timeout_ms: 1_000, continue_on_error: false }], step_budget_ms: 2_000,
  } as any;
  const preview = await previewRegion(monitored, cfg, { x: 200, y: 150 }, policy, { ownerId: "preview-steps-owner", retain: true });
  assert.equal(preview.selection?.selector, "#target", "preview selection sees the post-step DOM rather than the cookie overlay");
  assert.ok((preview.timings?.browser_steps ?? 0) >= 0, "workflow timing is separate from navigation timing");
  await closeRegionPreviewSessions();
});

test("preview and capture share cookie, status, mobile viewport and stale-workflow semantics", async (t) => {
  await closeRegionPreviewSessions();
  const fixture = managedServer(t, (req, res) => {
    if (req.url === "/error") {
      res.statusCode = 403;
      res.end(`<main id="error">Synthetic forbidden page</main>`);
      return;
    }
    res.end(`<!doctype html><style>body{margin:0}#consent{position:fixed;inset:0;background:#fff;z-index:3}#target{position:absolute;left:40px;top:80px;width:180px;height:60px;background:#0f0}</style><div id="consent" role="dialog" aria-modal="true" aria-label="Cookie consent"><button id="reject-cookies" onclick="this.parentElement.remove()">Reject all</button></div><button id="reject-offer" onclick="document.querySelector('#target').remove()">Reject offer</button><main id="target">Consistent product state</main>`);
  });
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const base = {
    ...monitor,
    id: randomUUID(),
    url: `http://preview-parity.example:${port}/`,
    kind: "browser", text_enabled: true, visual_enabled: true, capture_mode: "viewport", ignore_selectors: [], ignore_text: [], mask_selectors: [],
    cookie_banner_handling: true,
    browser_steps: [],
  } as any;
  const preview = await previewRegion({ ...base, visual_enabled: true }, cfg, { x: 100, y: 100 }, policy, { ownerId: "parity-owner", retain: true });
  assert.equal(preview.selection?.selector, "#target");
  await assert.rejects(
    previewRegion({ ...base, visual_enabled: true, browser_steps: [{ action: "wait_visible", selector: "#target", timeout_ms: 1000 }] }, cfg, { x: 100, y: 100 }, policy, { ownerId: "parity-owner", id: preview.session_id, retain: true }),
    (failure: any) => failure.status === 409 && failure.failure_code === "stale_configuration",
  );
  await closeRegionPreviewSessions();
  const scheduled = await capture({ ...base, text_enabled: true, visual_enabled: false, selector: "#target" }, cfg, policy);
  assert.equal(scheduled.text, "Consistent product state", "unrelated Reject offer button is never clicked");

  const mobile = await previewRegion({ ...base, visual_enabled: true, mobile_view: true }, cfg, { x: 100, y: 100 }, policy, { ownerId: "mobile-parity-owner", retain: true });
  assert.deepEqual([mobile.width, mobile.height], [390, 844]);
  assert.equal(mobile.selection?.selector, "#target");
  await closeRegionPreviewSessions();

  const error = await previewRegion({ ...base, url: `http://preview-parity.example:${port}/error`, visual_enabled: true, monitor_http_error_pages: true, browser_steps: [{ action: "wait_visible", selector: "#missing", timeout_ms: 100 }] }, cfg, undefined, policy, { ownerId: "error-preview-owner", retain: false });
  assert.equal(error.http_status, 403);
  assert.equal(error.warning, "browser_steps_skipped_http_error");

  await closeRegionPreviewSessions();
});

test("region preview deadline and cancellation stop browser work and release capacity", async (t) => {
  await closeRegionPreviewSessions();
  const fixture = managedServer(t, (req, res) => {
    if (req.url === "/large") {
      res.end(`<!doctype html><main>${"<span>node</span>".repeat(50_010)}</main>`);
      return;
    }
    res.end("<!doctype html><main id='preview-target' style='width:200px;height:80px'>Bounded preview</main>");
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], () => true, new Set([port]));
  const monitorFor = (pathName = "/") => ({ id: randomUUID(), url: `http://preview-deadline.example:${port}${pathName}`, kind: "browser", text_enabled: false, visual_enabled: true, browser_steps: [] }) as any;
  const deadlineCfg = { ...cfg, CAPTURE_TIMEOUT_MS: 2000 };
  const never = (page: any, entered: () => void) => async () => {
    entered();
    await page.evaluate(() => new Promise(() => {}));
  };

  let snapshotEntered!: () => void;
  const snapshotStarted = new Promise<void>((resolve) => { snapshotEntered = resolve; });
  const snapshotTimeout = previewRegion(monitorFor(), deadlineCfg, undefined, policy, {
    ownerId: "snapshot-timeout-owner", retain: true,
    operations: { snapshot: async (page) => never(page, snapshotEntered)() },
  });
  await snapshotStarted;
  const snapshotError: any = await snapshotTimeout.then(() => null, (error) => error);
  assert.deepEqual({ stage: snapshotError?.stage, code: snapshotError?.failure_code, status: snapshotError?.status }, { stage: "screenshot", code: "timeout", status: 504 });

  let screenshotEntered!: () => void;
  const screenshotStarted = new Promise<void>((resolve) => { screenshotEntered = resolve; });
  const screenshotTimeout = previewRegion(monitorFor(), deadlineCfg, undefined, policy, {
    ownerId: "screenshot-timeout-owner", retain: true,
    operations: { screenshot: async (_context, page) => { screenshotEntered(); await page.evaluate(() => new Promise(() => {})); return Buffer.alloc(0); } },
  });
  await screenshotStarted;
  const screenshotError: any = await screenshotTimeout.then(() => null, (error) => error);
  assert.deepEqual({ stage: screenshotError?.stage, code: screenshotError?.failure_code, status: screenshotError?.status }, { stage: "screenshot", code: "timeout", status: 504 });

  let cancelledEntered!: () => void;
  const cancellationStarted = new Promise<void>((resolve) => { cancelledEntered = resolve; });
  const controller = new AbortController();
  const cancelled = previewRegion(monitorFor(), cfg, undefined, policy, {
    ownerId: "cancelled-owner", retain: true, signal: controller.signal,
    operations: { snapshot: async (page) => never(page, cancelledEntered)() },
  });
  await cancellationStarted;
  controller.abort();
  await assert.rejects(cancelled, (error: any) => error.stage === "screenshot" && error.status === 499);

  await assert.rejects(
    previewRegion(monitorFor("/large"), cfg, undefined, policy, { ownerId: "large-dom-owner", retain: true }),
    (error: any) => error.stage === "screenshot" && error.failure_code === "resource_limit",
  );

  const recovered = await previewRegion(monitorFor(), cfg, undefined, policy, { ownerId: "recovered-owner", retain: true });
  assert.match(recovered.session_id!, /^[0-9a-f-]{36}$/, "timeouts and cancellation release preview capacity");
  const selected = await previewRegion(monitorFor(), cfg, { x: 100, y: 40 }, policy, { ownerId: "recovered-owner", id: recovered.session_id, retain: true });
  assert.equal(selected.selection?.selector, "#preview-target", "a recovered session remains coordinate accurate and reusable");
  const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
  await assert.rejects(previewRegion(monitorFor(), cfg, { x: 100, y: 40 }, policy, { ownerId: "recovered-owner", id: recovered.session_id, signal: alreadyCancelled.signal }),
    (error: any) => error.status === 499 && error.failure_code === "cancelled");
  await assert.rejects(previewRegion(monitorFor(), cfg, undefined, policy, { ownerId: "recovered-owner", id: recovered.session_id }),
    (error: any) => error.status === 410 && error.failure_code === "session_expired");
  await closeRegionPreviewSessions();
});
