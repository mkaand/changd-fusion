import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";

const channelKey = "b".repeat(64);
const cfg: any = {
  NODE_ENV: "test", DATABASE_URL: "postgres://fixture", JWT_SECRET: "k".repeat(32), CHANNEL_KEY: channelKey,
  PUBLIC_URL: "https://fusion.example.test", DATA_DIR: "/tmp/fusion-test", REGISTRATION_ENABLED: "false",
  RECOVERY_SMTP_HOST: "recovery.example.test", RECOVERY_SMTP_PORT: 587, RECOVERY_SMTP_USERNAME: "recovery-mailer", RECOVERY_SMTP_PASSWORD: "mock-only-recovery-secret", RECOVERY_SMTP_FROM: "no-reply@example.test",
  HISTORY_DAYS: 90, CAPTURE_TIMEOUT_MS: 30000, CHROMIUM_CONCURRENCY: 1, MAX_CAPTURE_WIDTH: 4096,
  MAX_CAPTURE_HEIGHT: 8192, MAX_CAPTURE_PIXELS: 8_000_000, LOG_LEVEL: "silent",
};

test("password reset uses only server-managed recovery SMTP through an injectable mock transport", async () => {
  const delivered: Record<string, string>[] = [];
  let transportOptions: Record<string, unknown> | undefined;
  const client = { query: async () => ({ rowCount: 0, rows: [] }), release: () => {} };
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT user_id,email FROM users")) return { rowCount: 1, rows: [{ user_id: "user-1", email: "member@example.com" }] };
      if (sql.includes("FROM fusion_channels")) throw Error("Recovery delivery must not query notification channels");
      return { rowCount: 0, rows: [] };
    },
    connect: async () => client,
  };
  const app = createApp(pool as any, cfg, undefined, {
    createMailTransport: (options) => { transportOptions = options; return { sendMail: async (message) => { delivered.push(message); } }; },
  });
  await request(app).post("/api/v1/password-reset/request").set("X-Fusion-Request", "1").send({ email: "member@example.com" }).expect(202, { ok: true });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].to, "member@example.com");
  assert.equal(transportOptions?.host, "recovery.example.test");
  assert.match(delivered[0].text, /https:\/\/fusion\.example\.test\/reset-password\?token=/);
  assert.ok(!JSON.stringify(delivered[0]).includes("mock-only-recovery-secret"));
});

test("missing recovery SMTP returns the generic response without minting a reset token", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("SELECT user_id,email FROM users")) return { rowCount: 1, rows: [{ user_id: "user-1", email: "member@example.com" }] };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => ({ query: async (sql: string) => { queries.push(sql); return { rowCount: 0, rows: [] }; }, release: () => {} }),
  };
  const app = createApp(pool as any, { ...cfg, RECOVERY_SMTP_HOST: undefined, RECOVERY_SMTP_PORT: undefined, RECOVERY_SMTP_USERNAME: undefined, RECOVERY_SMTP_PASSWORD: undefined, RECOVERY_SMTP_FROM: undefined });
  await request(app).post("/api/v1/password-reset/request").set("X-Fusion-Request", "1").send({ email: "member@example.com" }).expect(202, { ok: true });
  assert.ok(!queries.some((sql) => sql.includes("fusion_password_reset_tokens")));
});
