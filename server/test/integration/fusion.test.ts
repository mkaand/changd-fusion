import { test, before, after, type TestContext } from "node:test";
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
import { EgressPolicy } from "../../src/egress.js";
import { encrypt } from "../../src/crypto.js";
import { PNG } from "pngjs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
    (await pool.query("SELECT count(*) FROM fusion_migrations")).rows[0].count,
    "2",
  );
});
test("JWT, admin checks, CSRF, disabled registration and removed scheduler endpoint", async () => {
  await request(app).get("/api/v1/jobs").expect(401);
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
      `<main id="content"> Price   10 <span class="dynamic">time</span></main><img src="http://127.0.0.1:${privatePort}/private"><script>fetch('http://169.254.169.254/')</script>`,
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
  } finally {
    await closeServer(fixture);
    await closeServer(privateServer);
  }
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
    // Reconstruct the applied Sprint 1 schema, then upgrade only through migration 002.
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

test("browser smoke: sign in, monitor history, decimal display, image comparison and mobile layout", async (t) => {
  const { chromium } = await import("playwright");
  const { readFile } = await import("node:fs/promises");
  const apiServer = app.listen(0, "127.0.0.1");
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
    const file = req.url?.startsWith("/assets/")
      ? req.url.split("?")[0]
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
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("UI fixture runtime error:", e.message);
    });
    page.setDefaultTimeout(8000);
    await page.goto(origin);
    await page.getByLabel("Email", { exact: true }).fill("owner@example.com");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const output = process.env.UI_SCREENSHOT_DIR ?? root;
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "dashboard-desktop.png") });
    await page
      .getByRole("button", { name: "Hybrid fixture", exact: true })
      .click();
    await page.getByText("Monitoring history", { exact: true }).waitFor();
    await page.getByText("Visual: 0.35%", { exact: true }).first().waitFor();
    assert.ok(await page.getByAltText("Before capture").count());
    assert.ok(await page.getByAltText("After capture").count());
    const slider = page
      .getByRole("slider", { name: "Before / After comparison" })
      .first();
    await slider.focus();
    await slider.press("ArrowRight");
    assert.equal(await slider.getAttribute("aria-valuenow"), "51");
    await page.screenshot({ path: path.join(output, "history-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(
      () =>
        !!document.querySelector(".ant-layout-sider-collapsed") &&
        document.documentElement.scrollWidth <= window.innerWidth,
    );
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
    await page.getByLabel("Screenshot capture mode", { exact: true }).waitFor();
    await page.screenshot({
      path: path.join(output, "capture-settings-mobile.png"),
    });
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
    { sub: me.user_id, admin: true, user_type: 2 },
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
    await ownerAgent.get("/api/v1/users").expect(200);
  } finally {
    await pool.query("UPDATE users SET user_type=0 WHERE user_id=$1", [
      me.user_id,
    ]);
  }
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
      '<style>body{margin:0}#region{width:320px;height:240px;background:#fff}#tall{height:1800px}</style><main id="region">Hybrid region</main><div id="tall"></div>',
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
    await assert.rejects(
      capture(
        { ...base, capture_mode: "element", capture_selector: ".missing" },
        cfg,
        policy,
      ),
      /exactly one element/,
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
    const started = Date.now();
    await assert.rejects(
      capture(
        { ...base, url: `http://fixture.test:${port}/slow` },
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
