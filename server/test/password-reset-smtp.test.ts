import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { encrypt } from "../src/crypto.js";

const channelKey = "b".repeat(64);
const cfg: any = {
  NODE_ENV: "test", DATABASE_URL: "postgres://fixture", JWT_SECRET: "k".repeat(32), CHANNEL_KEY: channelKey,
  PUBLIC_URL: "https://fusion.example.test", DATA_DIR: "/tmp/fusion-test", REGISTRATION_ENABLED: "false",
  HISTORY_DAYS: 90, CAPTURE_TIMEOUT_MS: 30000, CHROMIUM_CONCURRENCY: 1, MAX_CAPTURE_WIDTH: 4096,
  MAX_CAPTURE_HEIGHT: 8192, MAX_CAPTURE_PIXELS: 8_000_000, LOG_LEVEL: "silent",
};

test("password reset uses the configured SMTP channel through an injectable mock transport", async () => {
  const delivered: Record<string, string>[] = [];
  const encrypted = encrypt({ host: "smtp.example.test", port: 587, from: "no-reply@example.test", to: "notifications@example.test", username: "mailer", password: "mock-only-secret" }, channelKey);
  const client = { query: async () => ({ rowCount: 0, rows: [] }), release: () => {} };
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT user_id,email FROM users")) return { rowCount: 1, rows: [{ user_id: "user-1", email: "member@example.test" }] };
      if (sql.includes("FROM fusion_channels")) return { rowCount: 1, rows: [{ config: { encrypted } }] };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => client,
  };
  const app = createApp(pool as any, cfg, undefined, {
    createMailTransport: () => ({ sendMail: async (message) => { delivered.push(message); } }),
  });
  await request(app).post("/api/v1/password-reset/request").set("X-Fusion-Request", "1").send({ email: "member@example.test" }).expect(202, { ok: true });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].to, "member@example.test");
  assert.match(delivered[0].text, /https:\/\/fusion\.example\.test\/reset-password\?token=/);
  assert.ok(!JSON.stringify(delivered[0]).includes("mock-only-secret"));
});
