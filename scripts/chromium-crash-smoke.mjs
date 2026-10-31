// Real PostgreSQL + sandboxed Chromium, destructive actions scoped exclusively
// to containers/networks created by this invocation. Never run against services.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statfs } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { makePool } from "../server/dist/db.js";
import { acquireChromiumLease } from "../server/dist/chromium-capacity.js";
import { recoverChromiumQuarantine, verifyStoppedContainers } from "../server/dist/chromium-recovery.js";

const execute = promisify(execFile);
const env = { ...process.env };
for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
async function docker(args, timeout = 20000) {
  const result = await execute("docker", ["--host=unix:///var/run/docker.sock", ...args], { env, timeout, maxBuffer: 512 * 1024 });
  return result.stdout.trim();
}
async function headroom() {
  const fs = await statfs(process.cwd());
  assert.ok(fs.bavail * fs.bsize >= 2 * 1024 ** 3, "Disk below 2 GiB: refusing another heavyweight test container");
}
async function until(fn, description, timeout = 20000) {
  const end = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
  throw Error(`Timed out: ${description}`);
}
const suffix = randomBytes(6).toString("hex");
const network = `fusion-crash-${suffix}`;
let pgId, runtime, pool;
let pgPaused = false;
let networkCreated = false;
const image = process.env.FUSION_DOCKER_IMAGE ?? "changd-fusion-api:ci";
const postgresImage = "postgres:16.15-alpine@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36";
const dist = path.resolve(process.env.FUSION_DOCKER_DIST ?? "server/dist");
const daemonId = await docker(["info", "--format", "{{.ID}}"]);
async function state(command) {
  const source = `const r=await fetch('http://127.0.0.1:8033/${command??""}',{method:'${command ? "POST" : "GET"}'});if(!r.ok)process.exit(1);console.log(await r.text());`;
  return JSON.parse(await docker(["exec", runtime, "node", "--input-type=module", "-e", source]));
}
async function token() { return (await pool.query("SELECT active_token FROM fusion_chromium_scheduler WHERE id=1")).rows[0].active_token; }
async function start(mode) {
  await headroom();
  const project = `crash-${suffix}-${mode}`;
  runtime = await docker(["run", "--detach", "--init", "--network", network,
    "--label", `com.docker.compose.project=${project}`, "--label", `com.docker.compose.service=${["capture", "handoff", "watchdog", "manual-crash", "resume"].includes(mode) ? "worker" : "api"}`,
    "--security-opt", `seccomp=${path.resolve("docker/chromium-seccomp.json")}`,
    "--cpus", "0.75", "--memory", "640m", "--pids-limit", "192", "--shm-size", "64m",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=134217728,mode=1777",
    "--mount", `type=bind,source=${dist},target=/app/dist,readonly`,
    "--mount", `type=bind,source=${path.resolve("server/migrations")},target=/app/migrations,readonly`,
    "--mount", `type=bind,source=${path.resolve("scripts/fixtures/chromium-crash-container.mjs")},target=/app/crash-fixture.mjs,readonly`,
    "--env", "DATABASE_URL=postgresql://postgres@crash-db/postgres", "--env", `CRASH_MODE=${mode}`, image, "node", "crash-fixture.mjs"], 60000);
  const fence = { daemonId, project, containerIds: [runtime] };
  let ready;
  try { ready = await until(async () => { try { const s = await state(); return s.ready && s; } catch { return false; } }, `${mode} browser start`); }
  catch (error) { console.error(await docker(["logs", "--tail", "30", runtime])); throw error; }
  assert.equal(ready.roots.length, mode === "resume" ? 0 : 1, `${mode}: one real browser tree, fully cleaned after completed run`);
  return fence;
}
async function disposeRuntime() {
  if (!runtime) return;
  const id = runtime;
  await docker(["stop", "--time", "2", id]);
  await docker(["rm", id]); // Only the exact disposable container just created.
  runtime = undefined;
}
try {
  await headroom();
  await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  try { await docker(["image", "inspect", "--format", "{{.Id}}", postgresImage]); }
  catch { await docker(["pull", postgresImage], 120000); }
  await docker(["network", "create", "--internal", network]);
  networkCreated = true;
  pgId = await docker(["run", "--detach", "--rm", "--network", network, "--network-alias", "crash-db", "--memory", "256m", "--pids-limit", "128", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", postgresImage], 60000);
  // The image's temporary init server accepts Unix sockets before the final
  // server listens on TCP. A socket-only pg_isready races fast CI hosts.
  await until(async () => { try { await docker(["exec", pgId, "pg_isready", "--host", "127.0.0.1", "-U", "postgres"]); return true; } catch { return false; } }, "disposable PostgreSQL TCP ready");
  const address = await docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", pgId]);
  // This is the Docker host reaching its own isolated test bridge, not host
  // networking or a route around the managed environment's outbound policy.
  pool = makePool(`postgresql://postgres@${address}:5432/postgres`);
  await until(async () => { try { await pool.query("SELECT 1"); return true; } catch { return false; } }, "Docker-host PostgreSQL TCP readiness");
  assert.match((await pool.query("SHOW server_version")).rows[0].server_version, /^16\.15\b/);

  for (const mode of ["capture", "preview", "orphan", "watchdog", "handoff"]) {
    const fence = await start(mode);
    if (mode === "watchdog") {
      const failed = await until(async () => { const s = await state(); return s.result && s; }, "real browser cleanup watchdog");
      assert.equal(failed.result, "WorkerFatalError");
      assert.equal(failed.resource, "browser");
    }
    if (mode === "handoff") {
      await state("waiter");
      await until(async () => (await state()).aborted, "scheduled capture observes real interactive priority");
    }
    const expected = await token();
    assert.ok(expected);
    await assert.rejects(recoverChromiumQuarantine(pool, expected, () => verifyStoppedContainers(fence)), /still connected/);
    await state("kill"); // SIGKILL only the known child actor in this test container.
    await until(async () => !(await pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND objid=1 AND granted", [0x43484645])).rowCount, "dead owner's advisory connection closes");
    if (mode === "orphan") assert.equal((await state()).roots.length, 1, "real sandboxed browser survives its Node parent");
    if (mode === "handoff") {
      const waiter = await until(async () => (await state()).waiterResult, "handoff fails closed after owner death");
      assert.equal(waiter.exited, true);
      assert.ok((await state()).roots.length <= 1, "waiting API replica never launches a second tree");
    }
    const finalState = await state();
    assert.equal(finalState.peakRoots, 1, `continuous process sampling detects no browser overlap; roots=${JSON.stringify(finalState.rootSamples)} lifecycle=${JSON.stringify(finalState.lifecycle)}`);
    await assert.rejects(acquireChromiumLease(pool, { workload: "preview", slots: 1 }), e => e.code === "cleanup_timeout");
    await assert.rejects(recoverChromiumQuarantine(pool, randomUUID(), async () => {}), /token changed/);
    await assert.rejects(recoverChromiumQuarantine(pool, expected, () => verifyStoppedContainers(fence)), /not conclusively stopped/);
    assert.equal(await token(), expected, "no timer, lease loss or process death clears quarantine");
    await docker(["stop", "--time", "2", runtime]);
    await recoverChromiumQuarantine(pool, expected, () => verifyStoppedContainers(fence));
    assert.equal(await token(), null);
    const lease = await acquireChromiumLease(pool, { workload: "capture", slots: 1 });
    assert.ok(lease); await lease.release();
    await disposeRuntime();
    console.log(`PASS: ${mode} SIGKILL/watchdog, real browser, quarantine, stopped-container fencing, exact-token recovery`);
  }

  for (const operation of ["pause", "restart"]) {
    const fence = await start("preview");
    if (operation === "pause") { await docker(["pause", pgId]); pgPaused = true; }
    else await docker(["restart", "--time", "2", pgId]);
    await until(async () => { const s = await state(); return s.aborted && s.roots.length === 0; }, `${operation}: coordination loss stops real resident Chromium`, 15000);
    if (pgPaused) { await docker(["unpause", pgId]); pgPaused = false; }
    await until(async () => { try { await pool.query("SELECT 1"); return true; } catch { return false; } }, "database connection recovery");
    // The living owner may complete its token-scoped cleanup; otherwise the
    // persisted fence remains, and only verified container fencing can clear it.
    await docker(["stop", "--time", "2", runtime]);
    const expected = await token();
    if (expected) {
      await assert.rejects(acquireChromiumLease(pool, { workload: "preview", slots: 1 }), e => e.code === "cleanup_timeout");
      await recoverChromiumQuarantine(pool, expected, () => verifyStoppedContainers(fence));
    }
    const lease = await acquireChromiumLease(pool, { workload: "capture", slots: 1 });
    assert.ok(lease); await lease.release();
    await disposeRuntime();
    console.log(`PASS: PostgreSQL ${operation}, client heartbeat deadline, browser cleanup and conservative recovery`);
  }

  {
    const fence = await start("preview");
    const expected = await token();
    await docker(["restart", "--time", "2", runtime]);
    const restarted = await until(async () => { try { const s = await state(); return s.actorExit && s; } catch { return false; } }, "restarted API fails closed on old quarantine");
    assert.equal(restarted.roots.length, 0);
    assert.equal(await token(), expected);
    await assert.rejects(acquireChromiumLease(pool, { workload: "capture", slots: 1 }), e => e.code === "cleanup_timeout");
    await docker(["stop", "--time", "2", runtime]);
    await recoverChromiumQuarantine(pool, expected, () => verifyStoppedContainers(fence));
    await docker(["start", runtime]);
    const recovered = await until(async () => { try { const s = await state(); return s.ready && s; } catch { return false; } }, "same container restarts safely after proven recovery");
    assert.equal(recovered.roots.length, 1);
    assert.equal(recovered.peakRoots, 1);
    assert.notEqual(await token(), expected);
    await docker(["stop", "--time", "2", runtime]);
    await recoverChromiumQuarantine(pool, await token(), () => verifyStoppedContainers(fence));
    await disposeRuntime();
    console.log("PASS: API container restart retains quarantine; verified recovery then restart admits exactly one tree");
  }

  // Kill a real Worker DURING a real manual capture, then retry the same durable
  // request after verified container fencing. No fabricated running status.
  const manualFence = await start("manual-crash");
  const monitor = (await state()).monitorId;
  const run = (await pool.query("SELECT id,status FROM fusion_manual_runs WHERE monitor_id=$1", [monitor])).rows[0];
  assert.equal(run.status, "running");
  const runId = run.id;
  const expected = await token();
  await state("kill");
  assert.equal((await pool.query("SELECT status FROM fusion_manual_runs WHERE id=$1", [runId])).rows[0].status, "running");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_captures WHERE monitor_id=$1", [monitor])).rows[0].n, 0);
  await docker(["stop", "--time", "2", runtime]);
  await recoverChromiumQuarantine(pool, expected, () => verifyStoppedContainers(manualFence));
  await disposeRuntime();
  console.log("PASS: real manual Worker SIGKILL preserves its running request without an incomplete capture");
  // The fixture preserves open manual monitor enablement on replacement.
  await start("resume");
  await until(async () => (await pool.query("SELECT status FROM fusion_manual_runs WHERE id=$1", [runId])).rows[0].status === "completed", "manual Check Now survives a Worker restart");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM fusion_captures WHERE monitor_id=$1", [monitor])).rows[0].n, 1);
  await disposeRuntime();
  console.log("PASS: recovered Worker completes durable manual run exactly once with real Chromium");
} finally {
  if (pgPaused && pgId) await docker(["unpause", pgId]);
  await pool?.end();
  await disposeRuntime();
  if (pgId) await docker(["stop", "--time", "2", pgId]); // --rm deletes only this synthetic database.
  if (networkCreated) await docker(["network", "rm", network]);
}
