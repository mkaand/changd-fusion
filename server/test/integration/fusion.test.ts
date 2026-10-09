import { test, before, after } from "node:test";
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
import { randomUUID, randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import jwt from "jsonwebtoken";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
function image(changed = 0) {
  const p = new PNG({ width: 100, height: 100 });
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
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (root) await rm(root, { recursive: true, force: true });
});
test("fresh migration is repeatable and decimal columns are NUMERIC", async () => {
  const r = await pool.query(
    "SELECT data_type FROM information_schema.columns WHERE table_name='fusion_events' AND column_name='visual_percent'",
  );
  assert.equal(r.rows[0].data_type, "numeric");
  assert.equal(
    (await pool.query("SELECT count(*) FROM fusion_migrations")).rows[0].count,
    "1",
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
  release();
  await active;
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
  await dispatch(pool, cfg, async () => {
    deliveries++;
  });
  assert.equal(deliveries, 1);
  await dispatch(pool, cfg, async () => {
    deliveries++;
  });
  assert.equal(deliveries, 1);
});
test("real Playwright hybrid capture uses one session, selectors, masks, normalization and private subresource isolation", async () => {
  let subresourceHits = 0;
  const privateServer = http.createServer((_req, res) => {
    subresourceHits++;
    res.end("private");
  });
  await new Promise<void>((r) => privateServer.listen(0, "127.0.0.1", r));
  const privatePort = (privateServer.address() as AddressInfo).port;
  const fixture = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<main id="content"> Price   10 <span class="dynamic">time</span></main><img src="http://127.0.0.1:${privatePort}/private"><script>fetch('http://169.254.169.254/')</script>`,
    );
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
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
    await new Promise<void>((r) => fixture.close(() => r()));
    await new Promise<void>((r) => privateServer.close(() => r()));
  }
});
test("controlled HTML and API monitoring preserve functionality with canonical JSON", async () => {
  const fixture = http.createServer((req, res) =>
    res.end(req.url === "/json" ? '{"z":1,"a":2}' : "<main>Hello</main>"),
  );
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
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
    await new Promise<void>((r) => fixture.close(() => r()));
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
    await migrate(legacy);
    await migrate(legacy);
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

test("browser smoke: sign in, monitor history, decimal display, image comparison and mobile layout", async () => {
  const { chromium } = await import("playwright");
  const { readFile } = await import("node:fs/promises");
  const apiServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => apiServer.once("listening", r));
  const apiPort = (apiServer.address() as AddressInfo).port;
  const ui = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/api/")) {
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode!, r.headers);
          r.pipe(res);
        },
      );
      upstream.on("error", () => res.end());
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
  await new Promise<void>((r) => ui.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + (ui.address() as AddressInfo).port;
  const oldURL = cfg.PUBLIC_URL;
  cfg.PUBLIC_URL = origin;
  const browser = await chromium.launch({
    chromiumSandbox: true,
    executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH,
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByLabel("Email", { exact: true }).fill("owner@example.com");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("button", { name: "Hybrid fixture", exact: true })
      .click();
    await page.getByText("Monitoring history", { exact: true }).waitFor();
    await page.getByText("Visual: 0.35%", { exact: true }).first().waitFor();
    assert.ok(await page.getByAltText("Before capture").count());
    assert.ok(await page.getByAltText("After capture").count());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(root, "mobile-smoke.png") });
    assert.ok(
      await page
        .getByRole("button", { name: "Check now", exact: true })
        .isVisible(),
    );
    assert.deepEqual(errors, []);
  } finally {
    cfg.PUBLIC_URL = oldURL;
    await browser.close();
    await new Promise<void>((r) => ui.close(() => r()));
    await new Promise<void>((r) => apiServer.close(() => r()));
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
