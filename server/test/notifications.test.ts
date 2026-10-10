import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deliver,
  emailHTML,
  summary,
  type EventMessage,
} from "../src/notifications.js";
import { Storage } from "../src/storage.js";
import { EgressPolicy } from "../src/egress.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
const fixtureImage = PNG.sync.write(new PNG({ width: 10, height: 10 }));
const event: EventMessage = {
  id: "synthetic-event",
  name: "Example monitor <script>",
  monitorId: "fixture",
  textChanged: true,
  visualChanged: true,
  percent: "0.3500000000",
  textSummary: "+ Price changed",
  link: "https://example.com/jobs/fixture",
  images: [],
};
test("HTML is escaped and decimal percent survives notification templates", () => {
  assert.ok(emailHTML(event).includes("0.35%"));
  assert.ok(!emailHTML(event).includes("<script>"));
  assert.ok(summary(event).includes("+ Price changed"));
});
test("SMTP requires verified TLS and attaches available images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusion-mail-")),
    store = new Storage(root);
  let transportOptions: any, mail: any;
  try {
    const image = await store.save(fixtureImage);
    await deliver(
      "smtp",
      {
        host: "smtp.example.com",
        port: 587,
        username: "fixture",
        password: "synthetic-fixture",
        from: "alerts@example.com",
        to: "recipient@example.com",
      },
      { ...event, images: [image] },
      store,
      {
        policy: new EgressPolicy(
          async () => [{ address: "8.8.8.8", family: 4 }],
          undefined,
          new Set([587]),
        ),
        smtp: ((opts: any) => {
          transportOptions = opts;
          return {
            sendMail: async (value: any) => {
              mail = value;
            },
            close: () => {},
          };
        }) as any,
      },
    );
    assert.equal(transportOptions.requireTLS, true);
    assert.equal(transportOptions.tls.rejectUnauthorized, true);
    assert.equal(transportOptions.tls.servername, "smtp.example.com");
    assert.ok(mail.html.includes("0.35%"));
    assert.equal(mail.attachments.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Telegram sends summary and an image album using mocked Bot API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusion-telegram-")),
    store = new Storage(root);
  const calls: any[] = [];
  try {
    const image = await store.save(fixtureImage);
    await deliver(
      "telegram",
      { token: "123456:" + "x".repeat(24), chat_id: "-123456" },
      { ...event, images: [image, image] },
      store,
      {
        telegram: async (_token, method, body, type) => {
          calls.push({ method, body: body.toString(), type });
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "sendMessage");
    assert.ok(calls[0].body.includes("0.35%"));
    assert.equal(calls[1].method, "sendMediaGroup");
    assert.ok(calls[1].body.includes("after.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("attention summaries identify the safe failure and oversized attachments are omitted; one Telegram image uses sendPhoto", async () => {
  const store = {
    read: async (name: string) =>
      name === "oversized" ? Buffer.alloc(4 * 1024 * 1024 + 1) : fixtureImage,
  } as Storage;
  const calls: any[] = [];
  const attention = {
    ...event,
    textChanged: false,
    visualChanged: false,
    attentionState: "persistent_failure",
    attentionMessage: "Check configuration and retry.",
    images: ["oversized", "small"],
  };
  assert.match(summary(attention), /persistent failure/);
  assert.match(
    emailHTML({ ...attention, attentionMessage: "<script>" }),
    /&lt;script&gt;/,
  );
  await deliver(
    "telegram",
    { token: "123456:" + "x".repeat(24), chat_id: "-123456" },
    attention,
    store,
    {
      telegram: async (_token, method, body) => {
        calls.push({ method, body });
      },
    },
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendMessage", "sendPhoto"],
  );
  assert.ok(calls[1].body.length < 1024);
  assert.ok(calls[0].body.toString().includes("Persistent Monitoring Failure"));
});
