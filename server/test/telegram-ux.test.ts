import { test } from "node:test";
import assert from "node:assert/strict";
import {
  telegramSummary,
  telegramSchema,
  deliver,
  truncateText,
  type EventMessage,
} from "../src/notifications.js";
import type { Storage } from "../src/storage.js";
import { PNG } from "pngjs";
const event: EventMessage = {
  id: "fixture",
  monitorId: "fixture",
  name: "Örnek Ürün Takibi",
  textChanged: true,
  visualChanged: true,
  percent: "0.3500000000",
  textSummary: "+ Fiyat bilgisi değişti",
  link: "https://example.com/jobs/fixture",
  images: [],
  checkedAt: "2026-10-10T10:23:00Z",
  eventType: "changed",
};
test("combined Telegram event is English, decimal-exact and uses Istanbul time", () => {
  const text = telegramSummary(event);
  for (const value of [
    "🔔",
    "🟢",
    "📝",
    "🖼️",
    "🔗",
    "0.35%",
    "2026-10-10 13:23 (Europe/Istanbul)",
    "Örnek Ürün Takibi",
  ])
    assert.ok(text.includes(value), value);
  assert.equal((text.match(/Change Detected/g) ?? []).length, 1);
});
test("text-only Telegram event has no fabricated visual result", () => {
  const text = telegramSummary({
    ...event,
    visualChanged: false,
    percent: null,
  });
  assert.ok(text.includes("📝 Text:"));
  assert.ok(!text.includes("🖼️"));
});
test("visual-only Telegram event keeps tiny, zero and 100 percent precision", () => {
  for (const [percent, expected] of [
    ["0.0000000001", "0.0000000001%"],
    ["0.0000000000", "0%"],
    ["100.0000000000", "100%"],
  ]) {
    const text = telegramSummary({ ...event, textChanged: false, percent });
    assert.ok(text.includes(expected));
    assert.ok(!text.includes("📝"));
  }
});
test("dimension-change Telegram event describes both images without 100 percent", () => {
  const text = telegramSummary({
    ...event,
    dimensionChanged: true,
    percent: null,
    beforeDimensions: { width: 1280, height: 900 },
    afterDimensions: { width: 1280, height: 1800 },
  });
  assert.ok(text.includes("📐 Dimensions: 1280×900 → 1280×1800"));
  assert.ok(text.includes("Pixel percentage unavailable"));
  assert.ok(!text.includes("%"));
});
for (const [state, expected] of [
  ["authentication_required", "🔐 Sign-in Required"],
  ["persistent_failure", "⚠️ Persistent Monitoring Failure"],
  ["challenge_detected", "🧩 Possible Challenge"],
]) {
  test(`Telegram attention state ${state} never includes internal errors or content differences`, () => {
    const text = telegramSummary({
      ...event,
      attentionState: state,
      attentionMessage: "synthetic-private-session-value",
    });
    assert.ok(text.includes(expected));
    assert.ok(!text.includes("synthetic-private"));
    assert.ok(!text.includes("📝"));
    assert.ok(!text.includes("%"));
    if (state === "challenge_detected")
      assert.ok(text.includes("may be present"));
  });
}
test("Telegram timezone is validated, defaults to UTC and respects daylight saving", () => {
  const token = "123456:" + "x".repeat(24);
  assert.equal(
    telegramSchema.parse({ token, chat_id: "-123456" }).timezone,
    "UTC",
  );
  assert.equal(
    telegramSchema.safeParse({
      token,
      chat_id: "-123456",
      timezone: "Not/A_Zone",
    }).success,
    false,
  );
  assert.ok(telegramSummary(event, "UTC").includes("10:23 (UTC)"));
  assert.ok(
    telegramSummary(
      { ...event, checkedAt: "2026-01-10T10:23:00Z" },
      "Europe/Berlin",
    ).includes("11:23"),
  );
  assert.ok(
    telegramSummary(
      { ...event, checkedAt: "2026-07-10T10:23:00Z" },
      "Europe/Berlin",
    ).includes("12:23"),
  );
});
test("Telegram mock sends one summary per combined event, no parse mode and safe Unicode truncation", async () => {
  const calls: any[] = [];
  const token = "123456:" + "x".repeat(24);
  await deliver(
    "telegram",
    { token, chat_id: "-123456", timezone: "UTC" },
    {
      ...event,
      name: "<b>Örnek</b>",
      textSummary: "[link](https://example.com) 😃".repeat(500),
      attempt: 2,
    },
    {} as Storage,
    {
      telegram: async (_token, method, body) => {
        calls.push({ method, body: JSON.parse(body.toString()) });
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "sendMessage");
  const body = calls[0].body;
  assert.equal(body.parse_mode, undefined);
  assert.ok(body.text.includes("<b>Örnek</b>"));
  assert.ok(body.text.includes("🔄 Notification retry: 2/5"));
  assert.ok(body.text.includes("🔗 Open monitor"));
  assert.ok(body.text.length <= 4000);
  assert.ok(!body.text.includes(token));
  assert.equal(truncateText("😃".repeat(10), 10), "😃😃😃😃…");
});
test("test notifications are explicitly labelled and credential-bearing links are omitted", () => {
  const text = telegramSummary({
    ...event,
    eventType: "test",
    link: "https://fixture:synthetic@ example.com",
  });
  assert.ok(text.includes("Test Notification"));
  assert.ok(!text.includes("📝"));
  assert.ok(!text.includes("synthetic"));
  assert.ok(
    !telegramSummary({
      ...event,
      link: "https://fixture:synthetic@example.com",
    }).includes("synthetic"),
  );
});
test("Telegram preserves an extreme-aspect screenshot as a document rather than an invalid photo", async () => {
  const image = PNG.sync.write(new PNG({ width: 10, height: 500 }));
  const calls: string[] = [];
  await deliver(
    "telegram",
    { token: "123456:" + "x".repeat(24), chat_id: "-123456" },
    { ...event, images: ["fixture"], imageLabels: ["after"] },
    { read: async () => image } as Storage,
    {
      telegram: async (_token, method, body) => {
        calls.push(method);
        if (method === "sendDocument")
          assert.ok(body.includes(Buffer.from('filename="after.png"')));
      },
    },
  );
  assert.deepEqual(calls, ["sendMessage", "sendDocument"]);
});
