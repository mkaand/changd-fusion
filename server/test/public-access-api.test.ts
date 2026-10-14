import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import { encrypt } from "../src/crypto.js";

const channelKey = "a".repeat(64);
const cfg: any = {
  NODE_ENV: "test", DATABASE_URL: "postgres://fixture", JWT_SECRET: "j".repeat(32), CHANNEL_KEY: channelKey,
  PUBLIC_URL: "https://fusion.example.test", DATA_DIR: "/tmp/fusion-test", REGISTRATION_ENABLED: "false",
  HISTORY_DAYS: 90, CAPTURE_TIMEOUT_MS: 30000, CHROMIUM_CONCURRENCY: 1, MAX_CAPTURE_WIDTH: 4096,
  MAX_CAPTURE_HEIGHT: 8192, MAX_CAPTURE_PIXELS: 8_000_000, LOG_LEVEL: "silent",
};
const owner = { user_id: "public-owner", firstname: "Public", lastname: "Owner", email: "owner@example.com", user_type: 0 };

function pool(publicEnabled: boolean) {
  const smtp = {
    id: "00000000-0000-4000-8000-000000000001", name: "SMTP", provider: "smtp", enabled: true,
    config: { encrypted: encrypt({ host: "smtp.example.test", port: 587, from: "no-reply@example.com", username: "mailer", password: "never-return-this" }, channelKey) },
  };
  return {
    query: async (sql: string) => {
      if (sql.includes("fusion_access_settings")) return publicEnabled ? { rowCount: 1, rows: [owner] } : { rowCount: 0, rows: [] };
      if (sql.includes("FROM fusion_channels WHERE user_id")) return { rowCount: 1, rows: [smtp] };
      if (sql.includes("FROM fusion_monitors WHERE user_id")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM fusion_monitors WHERE id=$1")) return { rowCount: 1, rows: [{ id: "00000000-0000-4000-8000-000000000002", user_id: owner.user_id }] };
      if (sql.includes("fusion_monitor_vault")) return { rowCount: 1, rows: [{ value_names: ["login"], expires_at: "2030-01-01T00:00:00Z", updated_at: "2029-01-01T00:00:00Z" }] };
      return { rowCount: 0, rows: [] };
    },
  };
}

test("public access enables standard workspace APIs but keeps account security operations closed before step-up", async () => {
  const app = createApp(pool(true) as any, cfg);
  await request(app).get("/api/v1/jobs").expect(200, []);
  const channels = await request(app).get("/api/v1/notifications").expect(200);
  assert.equal(channels.body[0].config.password, undefined);
  assert.equal(channels.body[0].config.username, "mailer");
  const vault = await request(app).get("/api/v1/jobs/00000000-0000-4000-8000-000000000002/private-values").expect(200);
  assert.deepEqual(vault.body.value_names, ["login"]);
  assert.equal(vault.body.encrypted, undefined);
  await request(app).get("/api/v1/account/public-access").expect(403);
});

test("public workspace APIs immediately reject anonymous callers when public access is off", async () => {
  const app = createApp(pool(false) as any, cfg);
  await request(app).get("/api/v1/jobs").expect(401);
  await request(app).get("/api/v1/notifications").expect(401);
});
