import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURE_CLEANUP_TIMEOUT_MS, closeWithDeadline } from "../src/capture.js";

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
