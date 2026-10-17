import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURE_CLEANUP_TIMEOUT_MS, closeWithDeadline, isElementFullyInViewport } from "../src/capture.js";

test("browser cleanup watchdog returns after an indefinitely hanging close", async () => {
  const started = Date.now();
  assert.equal(await closeWithDeadline(() => new Promise<void>(() => {}), 15), false);
  assert.ok(Date.now() - started < 250);
});

test("proxy cleanup watchdog is independently bounded", async () => {
  assert.equal(await closeWithDeadline(async () => {}, 15), true);
  assert.equal(await closeWithDeadline(() => new Promise<void>(() => {}), 15), false);
});

test("rejected cleanup is treated as a fatal-recovery outcome", async () => {
  assert.equal(await closeWithDeadline(async () => { throw Error("synthetic close rejection"); }, 15), false);
});

test("normal cleanup completes within the production safety deadline", async () => {
  assert.ok(CAPTURE_CLEANUP_TIMEOUT_MS >= 1_000);
  assert.equal(await closeWithDeadline(async () => {}, CAPTURE_CLEANUP_TIMEOUT_MS), true);
});

test("element capture skips scrolling only for a complete, visible viewport box", () => {
  const viewport = { width: 1280, height: 900 };
  assert.equal(isElementFullyInViewport({ x: 10, y: 12, width: 300, height: 150 }, viewport), true);
  assert.equal(isElementFullyInViewport({ x: 0, y: 0, width: 1280, height: 900 }, viewport), true);
  assert.equal(isElementFullyInViewport({ x: 1200, y: 0, width: 200, height: 100 }, viewport), false);
  assert.equal(isElementFullyInViewport({ x: 5, y: -1, width: 100, height: 100 }, viewport), false);
  assert.equal(isElementFullyInViewport({ x: 10, y: 10, width: 0, height: 100 }, viewport), false);
  assert.equal(isElementFullyInViewport(null, viewport), false);
  assert.equal(isElementFullyInViewport({ x: 10, y: 10, width: 100, height: 100 }, null), false);
});
