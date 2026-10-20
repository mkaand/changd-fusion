import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { closeServer } from "./helpers/server.js";
import { readConfig } from "../src/config.js";
import { stableElementBounds } from "../src/capture.js";
import { DEFAULT_CAPTURE_TIMEOUT_MS, effectiveCaptureTimeout } from "../src/capture-timeout.js";
import { PREVIEW_REQUEST_BUDGET_MS, previewCapacityWaitBudget } from "../src/region-picker.js";
test("fixture cleanup closes active keep-alive sockets even when responses never end", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write("pending");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const request = http.get(
    `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
  );
  request.on("error", () => {});
  try {
    await new Promise<void>((resolve) =>
      request.once("response", (response) => {
        response.on("error", () => {});
        resolve();
      }),
    );
  } finally {
    await closeServer(server);
    request.destroy();
  }
  assert.equal(server.listening, false);
});
test("resource configuration is bounded and defaults to a single Chromium capture", () => {
  const env = {
    DATABASE_URL: "postgresql://localhost/fixture",
    JWT_SECRET: randomBytes(32).toString("hex"),
    CHANNEL_KEY: randomBytes(32).toString("hex"),
  };
  assert.equal(readConfig(env).CHROMIUM_CONCURRENCY, 1);
  assert.equal(readConfig(env).PREVIEW_CAPACITY_WAIT_MS, 45_000);
  assert.equal(readConfig(env).CAPTURE_TIMEOUT_MS, DEFAULT_CAPTURE_TIMEOUT_MS);
  for (const [key, value] of [
    ["CHROMIUM_CONCURRENCY", "4"],
    ["MAX_CAPTURE_PIXELS", "16000001"],
    ["MAX_CAPTURE_HEIGHT", "8193"],
    ["CAPTURE_TIMEOUT_MS", "120001"],
  ]) {
    assert.throws(() => readConfig({ ...env, [key]: value }));
  }
});

test("preview admission has a separate bounded budget from browser execution", () => {
  assert.equal(previewCapacityWaitBudget({ PREVIEW_CAPACITY_WAIT_MS: 45_000 }, 30_000), 45_000);
  assert.equal(previewCapacityWaitBudget({ PREVIEW_CAPACITY_WAIT_MS: 45_000 }, 75_000), 35_000);
  assert.equal(previewCapacityWaitBudget({ PREVIEW_CAPACITY_WAIT_MS: 45_000 }, 90_000), 20_000);
  assert.equal(previewCapacityWaitBudget({ PREVIEW_CAPACITY_WAIT_MS: 45_000 }, PREVIEW_REQUEST_BUDGET_MS), 0);
});

test("element stability accepts a settled transient and rejects continuous movement within a bounded window", async () => {
  const box = (x: number) => ({ x, y: 0, width: 100, height: 40 });
  const settled = [box(0), box(4), box(4)];
  assert.deepEqual(await stableElementBounds(async () => settled.shift() ?? box(4), async () => {}, Date.now() + 1000), box(4));
  const moving = [box(0), box(3), box(6), box(9), box(12)];
  assert.equal(await stableElementBounds(async () => moving.shift() ?? box(15), async () => {}, Date.now() + 1000), null);
});


test("a monitor override is independent from the legacy server fallback", () => {
  assert.equal(effectiveCaptureTimeout({ capture_timeout_ms: 90_000 }, { CAPTURE_TIMEOUT_MS: 60_000 }), 90_000);
  assert.equal(effectiveCaptureTimeout({ capture_timeout_ms: null }, { CAPTURE_TIMEOUT_MS: 45_000 }), 45_000);
});
