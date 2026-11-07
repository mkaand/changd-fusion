import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = `ghcr.io/mkaand/changd-fusion-api@sha256:${"a".repeat(64)}`;
const ui = `ghcr.io/mkaand/changd-fusion-ui@sha256:${"b".repeat(64)}`;

test("checked-in GHCR override uses immutable images and removes every application build", () => {
  const environment = {
    ...process.env,
    POSTGRES_DB: "fixture",
    POSTGRES_USER: "fixture",
    POSTGRES_PASSWORD: "fixture",
    JWT_SECRET: "fixture",
    CHANNEL_KEY: "fixture",
    FUSION_API_IMAGE: api,
    FUSION_UI_IMAGE: ui,
  };
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    delete environment[name];
  }
  const result = spawnSync("docker", [
    "--host=unix:///var/run/docker.sock",
    "compose",
    "--project-directory", repository,
    "--project-name", "fusion_override_test",
    "--file", path.join(repository, "docker-compose.yml"),
    "--file", path.join(repository, "docker-compose.ghcr.yml"),
    "config", "--format", "json",
  ], {
    cwd: repository,
    env: environment,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2_000_000,
    shell: false,
  });
  assert.equal(result.status, 0);
  const model = JSON.parse(result.stdout);
  for (const service of ["api", "worker", "migrate", "ui"]) {
    assert.equal(model.services[service].build, undefined);
  }
  assert.equal(model.services.api.image, api);
  assert.equal(model.services.worker.image, api);
  assert.equal(model.services.migrate.image, api);
  assert.equal(model.services.ui.image, ui);
  assert.deepEqual(model.services.ui.ports, [{ mode: "ingress", target: 8080, published: "3000", protocol: "tcp", host_ip: "127.0.0.1" }]);

  const custom = spawnSync("docker", [
    "--host=unix:///var/run/docker.sock",
    "compose",
    "--project-directory", repository,
    "--project-name", "fusion_override_test",
    "--file", path.join(repository, "docker-compose.yml"),
    "--file", path.join(repository, "docker-compose.ghcr.yml"),
    "config", "--format", "json",
  ], {
    cwd: repository,
    env: { ...environment, FUSION_UI_HOST_PORT: "8126" },
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2_000_000,
    shell: false,
  });
  assert.equal(custom.status, 0);
  assert.deepEqual(JSON.parse(custom.stdout).services.ui.ports,
    [{ mode: "ingress", target: 8080, published: "8126", protocol: "tcp", host_ip: "127.0.0.1" }]);
});
