import assert from "node:assert/strict";
import test from "node:test";
import { browserProcessRoots } from "./fixtures/chromium-process-roots.mjs";

test("counts a fork chain as one Chromium browser root", () => {
  assert.deepEqual(browserProcessRoots([{ pid: 84, ppid: 34 }, { pid: 110, ppid: 84 }, { pid: 111, ppid: 110 }]), [{ pid: 84, ppid: 34 }]);
});

test("retains independently launched Chromium browser roots", () => {
  assert.deepEqual(browserProcessRoots([{ pid: 84, ppid: 34 }, { pid: 110, ppid: 55 }]), [{ pid: 84, ppid: 34 }, { pid: 110, ppid: 55 }]);
});
