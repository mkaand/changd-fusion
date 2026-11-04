import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdaterNotifier } from "./updater-telegram.mjs";

const token = `123456:${"a".repeat(40)}`;
const payload = { version: "0.3.3", source_sha: "b".repeat(40), operation_id: "11111111-1111-4111-8111-111111111111", health: "verified", timestamp: "2026-11-04T00:00:00Z" };

test("Telegram uses HTTPS, bounded safe content and no redirects", async () => {
  let observed;
  const notifier = new TelegramUpdaterNotifier({ token, chatId: "-123", fetchImpl: async (url, options) => {
    observed = { url, options }; return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } });
  assert.equal((await notifier.send("success", payload)).delivered, true);
  assert.match(observed.url, /^https:\/\/api\.telegram\.org\/bot/);
  assert.equal(observed.options.redirect, "error");
  const body = JSON.parse(observed.options.body);
  assert.match(body.text, /Version: 0\.3\.3/);
  assert.equal(body.text.includes(token), false);
});

test("delivery failure is sanitized and disabled/no-update paths are silent", async () => {
  const failed = new TelegramUpdaterNotifier({ token, chatId: "123", fetchImpl: async () => new Response("secret", { status: 500 }) });
  assert.deepEqual(await failed.send("critical", { stage: "deploy; token=x", category: "failure\nsecret", safe_stop: "retained" }), { delivered: false, error: "telegram_http_500" });
  assert.deepEqual(await new TelegramUpdaterNotifier().send("success", payload), { delivered: false, disabled: true });
  assert.throws(() => new TelegramUpdaterNotifier({ token: "bad", chatId: "1" }), /invalid_telegram_configuration/);
});
