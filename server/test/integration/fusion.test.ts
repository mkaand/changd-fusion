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
import { encrypt, decrypt } from "../../src/crypto.js";
import { PNG } from "pngjs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { seedPreview } from "../../src/preview-seed.js";
import { compareVisual } from "../../src/comparison.js";
import { telegramSummary } from "../../src/notifications.js";
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
    "4",
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
    assert.deepEqual(upgraded.browser_steps, []);
    assert.equal(upgraded.monitor_state, "healthy");
    assert.equal(
      (await legacy.query("SELECT count(*) FROM fusion_migrations")).rows[0]
        .count,
      "4",
    );
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
      .getByRole("button", { name: "Hybrid fixture", exact: true })
      .waitFor();
    await page
      .getByRole("searchbox", { name: "Search monitors" })
      .fill("Hybrid fixture");
    assert.equal(
      await page
        .getByRole("button", { name: "Dimension fixture", exact: true })
        .count(),
      0,
    );
    await page.screenshot({ path: path.join(output, "dashboard-desktop.png") });
    await themeSwitch.click();
    await page.screenshot({ path: path.join(output, "dashboard-desktop-dark.png") });
    await themeSwitch.click();
    await page.getByText("Settings", { exact: true }).first().click();
    await page.getByRole("heading", { name: "Settings" }).waitFor();
    await page.getByText("Notifications", { exact: true }).first().click();
    await page.getByRole("heading", { name: "Notification channels" }).waitFor();
    await page.screenshot({ path: path.join(output, "settings-notifications.png") });
    await page.getByText("Monitors", { exact: true }).first().click();
    await page.getByRole("searchbox", { name: "Search monitors" }).fill("");
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
  assert.equal(optional.warning, "optional_step_failed");
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
  for (const [path, message] of [
    ["/denied", "does not confirm a CAPTCHA"],
    ["/unauthorized", "HTTP 401"],
    ["/login", "Possible login screen"],
    ["/challenge", "Possible browser challenge"],
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
      (e) => e instanceof Error && e.message.includes(message),
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
  await post(two, "logout-all").expect(200);
  await me(two).expect(401);
  await me(foreign).expect(200);
  const three = await login(),
    four = await login();
  await post(three, "users/changepassword", {
    current_password: "incorrect",
    password: "synthetic-new-password",
  }).expect(401);
  await me(three).expect(200);
  await post(three, "users/changepassword", {
    current_password: password,
    password: "synthetic-new-password",
  }).expect(200);
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

test("failure state transitions preserve captures, back off and notify once per persistent or challenge state", async () => {
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
        throw Error("synthetic raw sensitive error");
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
  const count = async () =>
    (
      await pool.query(
        "SELECT count(*) FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1",
        [m.id],
      )
    ).rows[0].count;
  assert.equal(await count(), "1");
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
  assert.equal(await count(), "2");
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
      "4",
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
  await call("post", `/api/v1/jobs/${monitor.id}/run`, cookie)
    .send({})
    .expect(202);
  await runMonitor(pool, previewCfg, monitor.id, {
    force: true,
    capture: async () => ({ text: "before", screenshot: image(0) }),
  });
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
  const defaults = { interval_seconds: 900, capture_mode: "viewport", notification_mode: "digest", notification_cooldown_seconds: 900, channel_ids: [channelId] };
  await ownerAgent.put("/api/v1/preferences/monitoring").set("X-Fusion-Request", "1").send(defaults).expect(200);
  assert.equal((await ownerAgent.get("/api/v1/preferences/monitoring").expect(200)).body.notification_mode, "digest");
  await otherAgent.put("/api/v1/preferences/monitoring").set("X-Fusion-Request", "1").send({ channel_ids: [channelId] }).expect(404);
  await ownerAgent.post("/api/v1/monitors/notification-channels/bulk").set("X-Fusion-Request", "1").send({ monitor_ids: [monitor.id], channel_id: channelId, action: "add", confirm: true }).expect(204);
  await otherAgent.post("/api/v1/monitors/notification-channels/bulk").set("X-Fusion-Request", "1").send({ monitor_ids: [monitor.id], channel_id: channelId, action: "remove", confirm: true }).expect(404);
  const association = await pool.query("SELECT 1 FROM fusion_monitor_channels WHERE monitor_id=$1 AND channel_id=$2", [monitor.id, channelId]);
  assert.equal(association.rowCount, 1);
});
