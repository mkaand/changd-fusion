import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { navigateForCapture, stableElementBounds } from "../src/capture.js";
import { AttentionFailure } from "../src/attention.js";

function navigationPage(status: number, ready: () => Promise<void>) {
  const calls: string[] = [];
  const page = {
    async goto(_url: string, options: { waitUntil: string; timeout: number }) {
      calls.push(options.waitUntil);
      assert.ok(options.timeout > 0 && options.timeout <= 1000);
      return { ok: () => status >= 200 && status < 300, status: () => status };
    },
    url: () => "https://example.com/final",
    async waitForLoadState(state: string, options: { timeout: number }) {
      calls.push(state);
      assert.ok(options.timeout > 0 && options.timeout <= 1000);
      await ready();
    },
  } as unknown as Page;
  return { page, calls };
}

test("successful navigation retains DOMContentLoaded readiness and propagates readiness failures", async () => {
  const { page, calls } = navigationPage(200, async () => { throw Error("synthetic deferred script timeout"); });
  await assert.rejects(navigateForCapture(page, "https://example.com", Date.now() + 1000), /deferred script timeout/);
  assert.deepEqual(calls, ["commit", "domcontentloaded"]);
});

test("HTTP errors are rejected at commit without waiting for error-document scripts", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const { page, calls } = navigationPage(status, () => new Promise(() => {}));
    await assert.rejects(navigateForCapture(page, "https://example.com", Date.now() + 1000),
      status === 401 ? (error: unknown) => error instanceof AttentionFailure : /HTTP|unsuccessful/);
    assert.deepEqual(calls, ["commit"]);
  }
});

test("visible-region observation is reused but a fresh frame must still confirm stability", async () => {
  const initial = { x: 0, y: 0, width: 320, height: 240 };
  let samples = 0, frames = 0;
  assert.deepEqual(await stableElementBounds(async () => { samples++; return initial; }, async () => { frames++; }, Date.now() + 1000, initial), initial);
  assert.equal(samples, 1);
  assert.equal(frames, 1);
  const shifted = { ...initial, x: 4 };
  samples = 0;
  assert.deepEqual(await stableElementBounds(async () => { samples++; return shifted; }, async () => {}, Date.now() + 1000, initial), shifted);
  assert.equal(samples, 2, "a changed initial box needs two new equivalent observations");
});
