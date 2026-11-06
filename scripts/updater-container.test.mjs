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
  assert.match(dockerfile, /COPY docker\/chromium-seccomp\.json \.\/docker\/chromium-seccomp\.json/);
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

  assert.match(launcher, /mktemp -d \/run\/changd-fusion-updater\./);
  assert.match(launcher, /install -m 0400 -o 10001 -g 10001/);
  assert.match(launcher, /trap cleanup EXIT/);
  assert.match(launcher, /trap on_signal HUP INT TERM/);
  assert.match(launcher, /--cidfile/);
  assert.match(launcher, /readonly/);
  assert.match(launcher, /stage_root\/view/);
  assert.match(launcher, /unsupported_nested_compose_file/);

  assert.match(launcher, /FUSION_SECCOMP_PROFILE_FILE/);
  assert.match(launcher, /private\/chromium-seccomp\.json/);
  assert.match(launcher, /install -m 0400 -o 10001 -g 10001 "\$profile_canonical"/);
  assert.match(launcher, /seccomp_profile_outside_project/);
  assert.match(launcher, /ambiguous_seccomp_profile/);


  assert.match(launcher, /config_file="\$docker_config\/config\.json"/);
  assert.match(launcher, /\[ ! -L "\$config_file" \]/);
  assert.match(launcher, /stat -c %h "\$config_file"/);
  assert.match(launcher, /mkdir -m 0700 "\$stage_root\/docker-config"/);
  assert.match(launcher, /chown 10001:10001 "\$stage_root\/docker-config"/);
  assert.match(launcher, /install -m 0400 -o 10001 -g 10001 "\$config_file" "\$stage_root\/docker-config\/config\.json"/);
  assert.match(launcher, /src=\$stage_root\/docker-config,dst=\/home\/updater\/\.docker,readonly/);
  assert.doesNotMatch(launcher, /src=\$docker_config,dst=\/home\/updater\/\.docker/);

  assert.doesNotMatch(launcher, /chmod\s+0?644\s+["']?\$?(?:base_file|compose_env)|chmod\s+0?755\s+["']?\$?private/);

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
