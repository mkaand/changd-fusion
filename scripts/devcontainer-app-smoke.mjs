// Disposable Dev Container fixture: real production API/UI/worker, no forwarded port,
// no fake Codespaces gateway and no external monitoring or provider delivery.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { previewSecrets } from "./preview.mjs";
import { readConfig } from "../server/dist/config.js";
import { makePool } from "../server/dist/db.js";
import { createApp } from "../server/dist/app.js";
import { seedPreview } from "../server/dist/preview-seed.js";
const root = process.cwd(),
  secrets = await previewSecrets(root);
const password = (await readFile(".preview/db-password", "utf8")).trim();
const cfg = readConfig({
  NODE_ENV: "production",
  DATABASE_URL: `postgresql://fusion_preview:${password}@db:5432/fusion_preview`,
  JWT_SECRET: secrets.jwt,
  CHANNEL_KEY: secrets.key,
  PUBLIC_URL: "https://example.com",
  DATA_DIR: path.join(root, ".preview/data"),
  PLAYWRIGHT_EXECUTABLE_PATH: "/usr/bin/chromium",
  LOG_LEVEL: "silent",
});
const pool = makePool(cfg.DATABASE_URL);
let server, worker, cookie;
try {
  await seedPreview(pool, cfg, secrets.password);
  const app = createApp(pool, cfg, undefined, {
    frontendDir: path.join(root, "frontend/dist"),
    requireNotificationTest: true,
    allowedHosts: ["127.0.0.1:3000"],
  });
  server = await new Promise((resolve) => {
    const s = app.listen(3000, "127.0.0.1", () => resolve(s));
  });
  worker = spawn(process.execPath, ["server/dist/worker-main.js"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...Object.fromEntries(
        Object.entries(cfg).map(([k, v]) => [k, String(v)]),
      ),
    },
    stdio: "pipe",
  });
  worker.stdout.resume();
  worker.stderr.resume();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1000);
    worker.once("exit", () => {
      clearTimeout(timer);
      reject(Error("Worker failed"));
    });
    worker.once("error", () => {
      clearTimeout(timer);
      reject(Error("Worker failed"));
    });
  });
  async function call(route, method = "GET", body) {
    return fetch("http://127.0.0.1:3000" + route, {
      method,
      headers: {
        Origin: "https://example.com",
        "X-Fusion-Request": "1",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
  }
  const login = await call("/api/v1/login", "POST", {
    email: "preview@example.com",
    password: secrets.password,
  });
  assert.equal(login.status, 200);
  const header = login.headers.get("set-cookie");
  assert.ok(
    header.includes("Secure") &&
      header.includes("HttpOnly") &&
      header.includes("SameSite=Strict"),
  );
  cookie = header.split(";")[0];
  assert.equal((await call("/api/v1/users/me")).status, 200);
  const monitors = await (await call("/api/v1/jobs")).json();
  assert.equal(monitors.length, 1);
  assert.ok(
    monitors[0].paused &&
      monitors[0].text_enabled &&
      monitors[0].visual_enabled,
  );
  const h = await (
    await call("/api/v1/jobs/" + monitors[0].id + "/history?page=1")
  ).json();
  assert.equal(h.total, 2);
  const changed = h.items.find((e) => e.status === "changed");
  assert.equal(changed.visual_percent, "0.3500000000");
  for (const image of [
    changed.before_image,
    changed.after_image,
    changed.diff_screenshot,
  ]) {
    const r = await call("/api/v1/screenshots/" + image);
    assert.equal(r.status, 200);
    assert.ok((await r.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await call("/.preview/login.txt")).status, 404);
  assert.equal(
    (
      await call("/api/v1/jobs", "POST", {
        name: "Private fixture",
        url: "http://127.0.0.1",
      })
    ).status,
    400,
  );
  worker.kill("SIGSTOP");
  try {
    const input = {
      name: "Queue-only synthetic fixture",
      url: "https://8.8.8.8",
      text_enabled: true,
      visual_enabled: true,
      browser_steps: [
        { action: "wait_visible", selector: "//main", selector_type: "xpath" },
      ],
    };
    const r = await call("/api/v1/jobs", "POST", input);
    assert.equal(r.status, 201);
    const m = await r.json();
    assert.equal(m.browser_steps.length, 1);
    assert.equal(
      (await call("/api/v1/jobs/" + m.id + "/run", "POST", {})).status,
      202,
    );
    assert.equal(
      (await call("/api/v1/jobs/" + m.id, "PUT", { ...input, paused: true }))
        .status,
      200,
    );
  } finally {
    worker.kill("SIGCONT");
  }
  assert.equal((await call("/api/v1/notifications")).status, 200);
  assert.equal((await call("/")).status, 200);
  assert.equal((await call("/api/v1/logout", "POST", {})).status, 200);
  assert.equal((await call("/api/v1/users/me")).status, 401);
  console.log(
    "PASS: real Dev Container API/UI/worker, Secure login/logout, Steps monitor/Check-now queue, history/decimal/private screenshots and SSRF rejection; no external capture or provider send",
  );
} finally {
  if (worker && worker.exitCode === null) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill("SIGCONT");
    worker.kill("SIGTERM");
    const timer = setTimeout(() => worker.kill("SIGKILL"), 65000);
    await exited;
    clearTimeout(timer);
    assert.equal(worker.exitCode, 0);
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await pool.end();
}
