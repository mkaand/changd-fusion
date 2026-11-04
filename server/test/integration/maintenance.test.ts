import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makePool, type Pool } from "../../src/db.js";
import { migrate } from "../../src/migrate.js";
import { readConfig } from "../../src/config.js";
import { createApp } from "../../src/app.js";
import { acquireChromiumLease, createInteractivePriorityIntent, enqueueManualRun } from "../../src/chromium-capacity.js";
import { beginMaintenanceDrain, completeMaintenance, failMaintenance, maintenanceActive, verifyDrainEvidence } from "../../src/maintenance.js";
import { workerCycle } from "../../src/worker.js";

const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? "");
assert.ok(["127.0.0.1", "localhost"].includes(databaseUrl.hostname), "maintenance integration requires disposable local PostgreSQL");
const databaseName = `fusion_maintenance_${randomUUID().replaceAll("-", "")}`;
const admin = makePool(databaseUrl.href);
let pool: Pool;
let userId: string;
let monitorId: string;
const password = "maintenance-fixture-password";
const project = "fusion_maintenance_test";
const sourceSha = "a".repeat(40);

before(async () => {
  await admin.query(`CREATE DATABASE ${databaseName}`);
  databaseUrl.pathname = `/${databaseName}`;
  pool = makePool(databaseUrl.href);
  await migrate(pool);
  const user = await pool.query(
    "INSERT INTO users(email,password,firstname,lastname,user_type) VALUES('maintenance@example.com',$1,'Maintenance','Fixture',0) RETURNING user_id",
    [await hash(password, 4)],
  );
  userId = user.rows[0].user_id;
  monitorId = (await pool.query(
    "INSERT INTO fusion_monitors(user_id,name,url,kind,text_enabled,visual_enabled,next_run) VALUES($1,'Maintenance fixture','https://example.com','html',true,false,now()+interval '1 day') RETURNING id",
    [userId],
  )).rows[0].id;
});

afterEach(async () => {
  await pool.query("DELETE FROM fusion_maintenance");
  await pool.query("UPDATE fusion_manual_runs SET status='cancelled',updated_at=now() WHERE status IN ('queued','running')");
  await pool.query("UPDATE fusion_chromium_priority_intents SET cancelled_at=now() WHERE cancelled_at IS NULL");
});

after(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
  await admin.end();
});

test("idle drain atomically blocks Preview, Manual Check and scheduled Chromium until verified resume", async () => {
  const evidence = await beginMaintenanceDrain(pool, { project, sourceSha, timeoutMs: 2_000 });
  assert.equal(await maintenanceActive(pool), true);
  await assert.rejects(createInteractivePriorityIntent(pool, userId, "preview"), (error: any) => error.code === "capacity_busy");
  await assert.rejects(enqueueManualRun(pool, userId, monitorId, false), (error: any) => error.code === "capacity_busy");
  assert.equal(await acquireChromiumLease(pool, { workload: "capture", slots: 1 }), null);
  assert.equal(await verifyDrainEvidence(pool, evidence, "authorize"), true);
  assert.equal(await verifyDrainEvidence(pool, evidence, "authorize"), false, "authorization is single transition");
  assert.equal(await verifyDrainEvidence(pool, evidence, "assert"), true);
  assert.equal(await verifyDrainEvidence(pool, { ...evidence, project: "another_project" }, "assert"), false);
  assert.equal(await verifyDrainEvidence(pool, { ...evidence, source_sha: "b".repeat(40) }, "assert"), false);
  assert.equal(await completeMaintenance(pool, { ...evidence, expires_at: Date.now() - 1 }), false);
  assert.equal(await completeMaintenance(pool, evidence), true);
  assert.equal(await maintenanceActive(pool), false);
  const lease = await acquireChromiumLease(pool, { workload: "capture", slots: 1 });
  assert.ok(lease, "confirmed completion reopens admission");
  await lease.release();
});

for (const workload of ["capture", "preview"] as const) {
  test(`drain waits for active ${workload} cleanup while rejecting new admission`, async () => {
    const active = await acquireChromiumLease(pool, { workload, slots: 1 });
    assert.ok(active);
    let settled = false;
    const draining = beginMaintenanceDrain(pool, { project, sourceSha, timeoutMs: 2_000, pollMs: 20 }).finally(() => { settled = true; });
    for (let attempt = 0; attempt < 20 && !(await maintenanceActive(pool)); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await maintenanceActive(pool), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(settled, false, "process absence is not substituted for lease cleanup");
    await assert.rejects(createInteractivePriorityIntent(pool, userId, "preview"), (error: any) => error.code === "capacity_busy");
    await active!.release();
    const evidence = await draining;
    assert.equal(await verifyDrainEvidence(pool, evidence, "authorize"), true);
    assert.equal(await completeMaintenance(pool, evidence), true);
  });
}

test("HTTP Preview and Manual Check admission fail closed during maintenance", async () => {
  const evidence = await beginMaintenanceDrain(pool, { project, sourceSha, timeoutMs: 2_000 });
  const cfg = readConfig({
    NODE_ENV: "test", DATABASE_URL: databaseUrl.href,
    JWT_SECRET: randomBytes(32).toString("hex"), CHANNEL_KEY: randomBytes(32).toString("hex"),
  });
  const agent = request.agent(createApp(pool, cfg));
  await agent.post("/api/v1/login").set("X-Fusion-Request", "1").send({ email: "maintenance@example.com", password }).expect(200);
  const manual = await agent.post(`/api/v1/jobs/${monitorId}/run`).set("X-Fusion-Request", "1").send({}).expect(429);
  assert.equal(manual.body.failure_code, "capacity_busy");
  const preview = await agent.post("/api/v1/region-preview").set("X-Fusion-Request", "1").send({
    mode: "element", monitor: { url: "https://example.com", kind: "browser", visual_enabled: true },
  }).expect(429);
  assert.equal(preview.body.failure_code, "capacity_busy");
  assert.equal(await verifyDrainEvidence(pool, evidence, "authorize"), true);
  assert.equal(await completeMaintenance(pool, evidence), true);
});

test("drain waits for an actual non-browser Worker capture lifecycle", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "fusion-maintenance-worker-"));
  const cfg = readConfig({
    NODE_ENV: "test", DATABASE_URL: databaseUrl.href, DATA_DIR: dataDirectory,
    JWT_SECRET: randomBytes(32).toString("hex"), CHANNEL_KEY: randomBytes(32).toString("hex"),
  });
  const scheduledId = (await pool.query(
    "INSERT INTO fusion_monitors(user_id,name,url,kind,text_enabled,visual_enabled,next_run) VALUES($1,'Active maintenance capture','https://example.com','html',true,false,now()-interval '1 second') RETURNING id",
    [userId],
  )).rows[0].id;
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const cycle = workerCycle(pool, cfg, {
    capture: async (monitor) => {
      if (monitor.id === scheduledId) { started(); await gate; }
      return { text: "maintenance fixture", screenshot: null };
    },
    send: async () => {},
  });
  try {
    await active;
    let settled = false;
    const draining = beginMaintenanceDrain(pool, { project, sourceSha, timeoutMs: 2_000, pollMs: 20 }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(settled, false, "non-browser capture is part of the drain proof");
    unblock();
    await cycle;
    const evidence = await draining;
    assert.equal(await verifyDrainEvidence(pool, evidence, "authorize"), true);
    assert.equal(await completeMaintenance(pool, evidence), true);
  } finally {
    unblock();
    await cycle;
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("drain timeout and interrupted deployment retain the durable fail-closed barrier", async () => {
  const active = await acquireChromiumLease(pool, { workload: "preview", slots: 1 });
  assert.ok(active);
  await assert.rejects(
    beginMaintenanceDrain(pool, { project, sourceSha, timeoutMs: 100, pollMs: 10 }),
    (error: any) => error.code === "drain_timeout",
  );
  await active!.release();
  assert.equal((await pool.query("SELECT state FROM fusion_maintenance WHERE id=1")).rows[0].state, "recovery_required");
  await assert.rejects(beginMaintenanceDrain(pool, { project, sourceSha }), (error: any) => error.code === "maintenance_already_active");
  assert.equal(await acquireChromiumLease(pool, { workload: "capture", slots: 1 }), null);
});

test("lost ownership, stale evidence and deployment failure cannot reopen admission", async () => {
  const evidence = await beginMaintenanceDrain(pool, { project, sourceSha, timeoutMs: 2_000 });
  assert.equal(await verifyDrainEvidence(pool, { ...evidence, expires_at: Date.now() - 1 }, "authorize"), false);
  await pool.query("UPDATE fusion_maintenance SET owner_token_hash=$1 WHERE id=1", ["0".repeat(64)]);
  assert.equal(await verifyDrainEvidence(pool, evidence, "authorize"), false);
  assert.equal(await completeMaintenance(pool, evidence), false);
  await pool.query("DELETE FROM fusion_maintenance");
  const replacement = await beginMaintenanceDrain(pool, { project, sourceSha, timeoutMs: 2_000 });
  assert.equal(await verifyDrainEvidence(pool, replacement, "authorize"), true);
  assert.equal(await failMaintenance(pool, replacement, "interrupted_deployment"), true);
  assert.equal((await pool.query("SELECT state FROM fusion_maintenance WHERE id=1")).rows[0].state, "recovery_required");
  assert.equal(await completeMaintenance(pool, replacement), false);
  assert.equal(await acquireChromiumLease(pool, { workload: "preview", slots: 1 }), null);
});

test("a browser racing drain confirmation is either prior active work or rejected, never post-drain work", async () => {
  const operationId = randomUUID();
  const draining = beginMaintenanceDrain(pool, { project, sourceSha, operationId, timeoutMs: 2_000, pollMs: 10 });
  const racing = acquireChromiumLease(pool, { workload: "capture", slots: 1 });
  const lease = await racing;
  if (lease) await lease.release();
  const evidence = await draining;
  assert.equal(evidence.operation_id, operationId);
  assert.equal(await acquireChromiumLease(pool, { workload: "capture", slots: 1 }), null);
  assert.equal(await verifyDrainEvidence(pool, evidence, "authorize"), true);
  assert.equal(await completeMaintenance(pool, evidence), true);
});
