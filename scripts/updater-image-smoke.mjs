import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync("docker", [
  "run", "--rm", "--entrypoint", "sh", "changd-fusion-updater:ci", "-c",
  "node --version && gh --version | head -1 && docker --version && docker compose version && id -u",
], { encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000, shell: false });

assert.equal(result.status, 0, result.stderr);
const lines = result.stdout.trim().split("\n");
assert.match(lines[0], /^v24\./);
assert.match(lines[1], /^gh version 2\.103\.3\b/);
assert.match(lines[2], /^Docker version 28\.4\.0\b/);
assert.match(lines[3], /^Docker Compose version v2\./);
assert.equal(lines.at(-1), "10001", "the updater runtime is non-root inside the container");
