import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const text = async (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("updater image contains the pinned non-root Node, Docker Compose and GitHub verifier toolchain", async () => {
  const dockerfile = await text("updater/Dockerfile");
  assert.match(dockerfile, /FROM node:24-bookworm-slim@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /FROM docker:28\.4\.0-cli@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /GH_VERSION=2\.103\.3/);
  assert.match(dockerfile, /GH_ARCHIVE_SHA256=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/opt\/changd-fusion-updater\/scripts\/ghcr-updater-runtime\.mjs"\]/);
});

test("host launcher pins the image, mounts only explicit paths and acknowledges the root-equivalent socket boundary", async () => {
  const launcher = await text("scripts/run-ghcr-updater-container.sh");
  assert.match(launcher, /changd-fusion-updater@sha256:\[0-9a-f\]\{64\}/);
  assert.match(launcher, /--read-only/);
  assert.match(launcher, /--cap-drop ALL/);
  assert.match(launcher, /--security-opt no-new-privileges:true/);
  assert.match(launcher, /--user 10001:10001/);
  assert.match(launcher, /src=\/var\/run\/docker\.sock,dst=\/var\/run\/docker\.sock/);
  assert.doesNotMatch(launcher, /--privileged|docker system prune|docker image prune/);
  assert.equal(spawnSync("sh", ["-n", "scripts/run-ghcr-updater-container.sh"]).status, 0);
  assert.equal(spawnSync("sh", ["-n", "scripts/install-ghcr-updater.sh"]).status, 0);
});

test("systemd remains opt-in, host-Node-free and checks approximately every five minutes", async () => {
  const service = await text("systemd/changd-fusion-updater.service");
  const timer = await text("systemd/changd-fusion-updater.timer");
  assert.match(service, /ExecStart=\/usr\/local\/sbin\/changd-fusion-updater-container/);
  assert.doesNotMatch(service, /\bnode\b|npm|npx/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.doesNotMatch(timer, /WantedBy=.*multi-user/);
});

test("updater publication is exact-SHA gated, immutable and attested", async () => {
  const workflow = await text(".github/workflows/ghcr-updater-release.yml");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /node scripts\/ghcr-ci-gate\.mjs verify/);
  assert.match(workflow, /ghcr\.io\/mkaand\/changd-fusion-updater/);
  assert.match(workflow, /actions\/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be/);
  assert.match(workflow, /subject-digest: \$\{\{ steps\.updater\.outputs\.digest \}\}/);
  assert.doesNotMatch(workflow, /tags:\s*.*(?:^|:)latest(?:\s|$)/m);
});
