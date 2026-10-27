import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyStoppedContainers } from "../src/chromium-recovery.js";

const id = "a".repeat(64);
const fence = { daemonId: "fixture-daemon", project: "fixture", containerIds: [id] };
function read(overrides: Record<string, unknown> = {}, restart = "no", extra = false, pidMode = "", privileged = false) {
  return async (args: string[]) => {
    if (args[0] === "info") return "fixture-daemon\n";
    if (args[0] === "ps") return `${id}\n`;
    const state = { Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0, Status: "exited", FinishedAt: "2026-10-27T00:00:00Z", ...overrides };
    const line = (container: string) => JSON.stringify([container, state, restart, { "com.docker.compose.project": "fixture", "com.docker.compose.service": "api" }, pidMode, privileged]);
    return line(id) + (extra ? `\n${line("b".repeat(64))}` : "");
  };
}
test("offline fencing requires exact daemon, project and full stopped replica inventory", async () => {
  await verifyStoppedContainers(fence, read());
  await assert.rejects(verifyStoppedContainers({ ...fence, daemonId: "other" }, read()), /identity mismatch/);
  await assert.rejects(verifyStoppedContainers({ ...fence, containerIds: ["short"] }, read()), /Invalid fencing scope/);
  await assert.rejects(verifyStoppedContainers(fence, read({}, "no", true)), /inventory mismatch/);
});
test("live, paused, restarting, ambiguous, never-started or auto-restarted containers are not fencing proof", async () => {
  for (const state of [{ Running: true }, { Paused: true }, { Restarting: true }, { Dead: true }, { Pid: 32 }, { Status: "created" }, { FinishedAt: "0001-01-01T00:00:00Z" }])
    await assert.rejects(verifyStoppedContainers(fence, read(state)), /not conclusively stopped/);
  await assert.rejects(verifyStoppedContainers(fence, read({}, "unless-stopped")), /not conclusively stopped/);
  await assert.rejects(verifyStoppedContainers(fence, read({}, "no", false, "host")), /outside supported fencing scope/);
  await assert.rejects(verifyStoppedContainers(fence, read({}, "no", false, "container:other")), /outside supported fencing scope/);
  await assert.rejects(verifyStoppedContainers(fence, read({}, "no", false, "", true)), /outside supported fencing scope/);
});
