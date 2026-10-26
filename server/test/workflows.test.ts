import { test } from "node:test";
import assert from "node:assert/strict";
import { stepsSchema, runSteps, StepFailure } from "../src/browser-steps.js";
import { detectAttention, AttentionFailure } from "../src/attention.js";
import { sealValues, openValues, vaultSchema } from "../src/vault.js";
import { randomUUID, randomBytes } from "node:crypto";
import { Storage } from "../src/storage.js";
import { captureFailure } from "../src/errors.js";

test("browser steps reject execution, navigation, oversized input and unsafe optional actions", () => {
  for (const input of [
    [{ action: "javascript", value: "alert(1)" }],
    [{ action: "click", selector: "#x", continue_on_error: true }],
    [
      {
        action: "fill_private",
        selector: "#x",
        credential: "key",
        continue_on_error: true,
      },
    ],
    [{ action: "delay", duration_ms: 5001 }],
    [{ action: "scroll_by", y: 5001 }],
    [{ action: "wait_navigation", path: "//example.com" }],
    [{ action: "click", selector: "#x", timeout_ms: 60001 }],
    [{ action: "click", selector: "#x", timeout_ms: 99 }],
    Array.from({ length: 21 }, () => ({ action: "delay", duration_ms: 0 })),
  ])
    assert.equal(stepsSchema.safeParse(input).success, false);
  assert.equal(
    stepsSchema.safeParse([
      {
        action: "dismiss_cookie",
        selector: "//button",
        selector_type: "xpath",
        continue_on_error: true,
      },
    ]).success,
    true,
  );
});
test("ordered steps pass only validated actions and CSS/XPath locators to Playwright", async () => {
  const calls: string[] = [];
  const node = {
    waitFor: async (o: any) => calls.push(o.state),
    click: async () => calls.push("click"),
    scrollIntoViewIfNeeded: async () => calls.push("scroll"),
    selectOption: async (v: string) => calls.push("select:" + v),
    fill: async (v: string) => calls.push("fill:" + v),
  };
  const page: any = {
    locator: (s: string) => {
      calls.push(s);
      return node;
    },
    evaluate: async (_: any, p: any) => calls.push("scroll:" + p.y),
    waitForTimeout: async (n: number) => calls.push("delay:" + n),
    url: () => "https://example.com/start",
    waitForURL: async (s: string) => calls.push(s),
    close: async () => {},
  };
  await runSteps(
    page,
    [
      { action: "wait_selector", selector: "#x" },
      { action: "wait_visible", selector: "//main", selector_type: "xpath" },
      { action: "click", selector: "#x" },
      { action: "scroll_to", selector: "#x" },
      { action: "scroll_by", y: 500 },
      { action: "delay", duration_ms: 0 },
      { action: "select_option", selector: "select", value: "news" },
      { action: "fill_literal", selector: "input", value: "public" },
      { action: "fill_private", selector: "input", credential: "fixture" },
      { action: "wait_navigation", path: "/complete" },
    ],
    Date.now() + 2000,
    { fixture: "synthetic-private-value" },
  );
  assert.deepEqual(calls, [
    "css=#x",
    "attached",
    "xpath=//main",
    "visible",
    "css=#x",
    "attached",
    "click",
    "css=#x",
    "scroll",
    "scroll:500",
    "delay:0",
    "css=select",
    "select:news",
    "css=input",
    "fill:public",
    "css=input",
    "fill:synthetic-private-value",
    "https://example.com/complete",
  ]);
});
test("step failures never expose field values, selector details or internal errors", async () => {
  const secret = "synthetic-sensitive-fixture";
  const page: any = {
    locator: () => ({
      fill: async () => {
        throw Error(secret);
      },
    }),
    close: async () => {},
  };
  await assert.rejects(
    runSteps(
      page,
      [{ action: "fill_private", selector: "#private", credential: "fixture" }],
      Date.now() + 1000,
      { fixture: secret },
    ),
    (e) =>
      e instanceof StepFailure &&
      e.step === 1 &&
      !e.message.includes(secret) &&
      !e.message.includes("#private"),
  );
});
test("optional safe steps report a warning and mandatory failures stop the sequence", async () => {
  let clicks = 0;
  const page: any = {
    locator: (selector: string) => ({
      waitFor: async () => {
        if (selector.includes("missing")) throw Error();
      },
      click: async () => {
        clicks++;
      },
    }),
    close: async () => {},
  };
  assert.deepEqual(
    await runSteps(
      page,
      [
        {
          action: "wait_visible",
          selector: "#missing",
          continue_on_error: true,
        },
        { action: "click", selector: "#ok" },
      ],
      Date.now() + 1000,
    ),
    {
      code: "optional_step_failed",
      step: 1,
      action: "wait_visible",
      category: "selector_unavailable",
    },
  );
  assert.equal(clicks, 1);
  await assert.rejects(
    runSteps(
      page,
      [
        { action: "wait_visible", selector: "#missing" },
        { action: "click", selector: "#ok" },
      ],
      Date.now() + 1000,
    ),
  );
  assert.equal(clicks, 1);
});
test("workflow timer closes stalled browser work and cleanup leaves no live timer", async () => {
  let reject: (e: Error) => void = () => {};
  let closed = 0;
  const page: any = {
    locator: () => ({
      waitFor: async () => {},
      click: () =>
        new Promise((_, r) => {
          reject = r;
        }),
    }),
    close: async () => {
      closed++;
      reject(Error("closed"));
    },
  };
  await assert.rejects(
    runSteps(page, [{ action: "click", selector: "#x" }], Date.now() + 30),
  );
  assert.equal(closed, 1);
  await assert.rejects(
    runSteps(page, [{ action: "delay", duration_ms: 5000 }], Date.now() + 10),
  );
});
test("step timeout boundaries preserve saved steps and clamp to workflow/capture deadlines", async () => {
  for (const timeout_ms of [100, 10000, 60000]) {
    assert.equal(stepsSchema.parse([{ action: "click", selector: "#fixture", timeout_ms }])[0].timeout_ms, timeout_ms);
    let received = 0;
    const page: any = { close: async () => {}, locator: () => ({ waitFor: async () => {}, click: async ({ timeout }: any) => { received = timeout; } }) };
    await runSteps(page, [{ action: "click", selector: "#fixture", timeout_ms }], Date.now() + 20000, {}, Date.now() + 1000);
    assert.ok(received > 0 && received <= Math.min(timeout_ms, 1000));
  }
  assert.equal(stepsSchema.parse([{ action: "click", selector: "#fixture" }])[0].timeout_ms, 5000);
  for (const capture of [false, true]) {
    const page: any = { close: async () => {} };
    await assert.rejects(runSteps(page, [{ action: "click", selector: "#private" }], capture ? Date.now() + 60000 : Date.now() - 1, {}, capture ? Date.now() - 1 : Infinity), (e: any) => e instanceof StepFailure && e.category === (capture ? "capture_deadline" : "workflow_deadline"));
  }
});

test("click diagnostics separate missing selectors, actionability and timeout without exposing page text", async () => {
  for (const [message, name, attached, category] of [
    ["private selector secret", "TimeoutError", false, "selector_missing"],
    ["element is not visible secret", "TimeoutError", true, "element_not_actionable"],
    ["private page text secret", "TimeoutError", true, "step_timeout"],
  ] as const) {
    const error = Object.assign(Error(message), { name });
    const page: any = { close: async () => {}, locator: () => ({ waitFor: async () => { if (!attached) throw error; }, click: async () => { throw error; } }) };
    await assert.rejects(runSteps(page, [{ action: "click", selector: "#secret" }], Date.now() + 2000), (e: any) => e instanceof StepFailure && e.category === category && !e.message.includes("secret"));
  }
});

test("capture diagnostics retain safe step context and explain stability timeouts", () => {
  for (const category of ["step_timeout", "selector_missing", "element_not_actionable", "workflow_deadline", "capture_deadline"] as const) {
    const error = new StepFailure(2, "click", category);
    const failure = captureFailure(error, "browser_steps");
    assert.equal(failure.message, error.message);
    assert.equal(failure.stage, "browser_steps");
    assert.notEqual(failure.code, "unknown");
  }
  const failure = captureFailure(Object.assign(Error("private synthetic contents"), { name: "TimeoutError" }), "element_stability");
  assert.equal(failure.code, "timeout");
  assert.match(failure.message, /stability.*deadline/);
  assert.ok(!failure.message.includes("private"));
});

test("challenge detection differentiates confirmed 401, heuristic challenge and ordinary 403", () => {
  const a = detectAttention(401, "/", "", false, false);
  assert.ok(a instanceof AttentionFailure);
  assert.equal(a.confidence, "confirmed");
  assert.equal(a.state, "authentication_required");
  const b = detectAttention(403, "/", "", false, false);
  assert.ok(b);
  assert.ok(!(b instanceof AttentionFailure));
  assert.match(b.message, /does not confirm/);
  const c = detectAttention(200, "/", "Just a moment...", false, false);
  assert.ok(c instanceof AttentionFailure);
  assert.equal(c.confidence, "heuristic");
  assert.equal(c.state, "challenge_detected");
  assert.equal(
    detectAttention(200, "/articles/captcha-guide", "Article", false, false),
    null,
  );
  const d = detectAttention(200, "/login", "Sign in", true, false);
  assert.ok(d instanceof AttentionFailure);
  assert.equal(d.state, "authentication_required");
  assert.equal(
    detectAttention(200, "/feedback", "Feedback", true, false),
    null,
  );
});
test("private values encryption is bound to owner, monitor and origin; expired and tampered material fail closed", () => {
  const id = randomUUID(),
    user = randomUUID(),
    key = randomBytes(32).toString("hex"),
    values = { account: "synthetic-private-value" },
    m = { id, user_id: user, url: "https://example.com/path" };
  const row = {
    monitor_id: id,
    user_id: user,
    origin: "https://example.com",
    expires_at: new Date(Date.now() + 60000).toISOString(),
    encrypted: sealValues(values, key, id, user, "https://example.com"),
  };
  assert.ok(!row.encrypted.includes(values.account));
  assert.deepEqual(openValues(row, key, m), values);
  assert.throws(() => openValues(row, key, { ...m, id: randomUUID() }));
  assert.throws(() => openValues(row, key, { ...m, user_id: randomUUID() }));
  assert.throws(() =>
    openValues(row, key, { ...m, url: "https://other.example.com" }),
  );
  assert.throws(() =>
    openValues({ ...row, expires_at: new Date(0).toISOString() }, key, m),
  );
  assert.throws(() => openValues({ ...row, monitor_id: randomUUID() }, key, m));
  assert.throws(() =>
    openValues(
      { ...row, encrypted: row.encrypted.slice(0, -4) + "AAAA" },
      key,
      m,
    ),
  );
});
test("private vault input enforces expiration and bounded safe references", () => {
  assert.equal(
    vaultSchema.safeParse({
      values: { fixture: "synthetic" },
      expires_at: new Date(Date.now() + 60000).toISOString(),
    }).success,
    true,
  );
  for (const v of [
    { values: {}, expires_at: new Date(Date.now() + 60000).toISOString() },
    { values: { key: "x" }, expires_at: new Date(0).toISOString() },
    {
      values: { key: "x" },
      expires_at: new Date(Date.now() + 31 * 86400000).toISOString(),
    },
    {
      values: { "../key": "x" },
      expires_at: new Date(Date.now() + 60000).toISOString(),
    },
  ])
    assert.equal(vaultSchema.safeParse(v).success, false);
});
test("artifact size limit rejects excessive writes before creating any file", async () => {
  await assert.rejects(
    new Storage("/tmp/fusion-unused-size-fixture").save(
      Buffer.alloc(16 * 1024 * 1024 + 1),
    ),
    /storage limit/,
  );
});
test("scroll evaluation respects its own step timeout even when the page is stalled", async () => {
  let reject: (e: Error) => void = () => {};
  let closed = 0;
  const page: any = {
    evaluate: () =>
      new Promise((_, r) => {
        reject = r;
      }),
    close: async () => {
      closed++;
      reject(Error("closed"));
    },
  };
  const started = Date.now();
  await assert.rejects(
    runSteps(
      page,
      [{ action: "scroll_by", y: 100, timeout_ms: 100 }],
      Date.now() + 2000,
    ),
  );
  assert.equal(closed, 1);
  assert.ok(Date.now() - started < 1000);
});
