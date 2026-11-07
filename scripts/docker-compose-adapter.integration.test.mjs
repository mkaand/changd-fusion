import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createDockerComposeHostAdapter } from "./docker-compose-adapter.mjs";

const enabled = process.env.RUN_DOCKER_ADAPTER_INTEGRATION === "1";

async function availableLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function docker(args, cwd, timeout = 60_000) {
  const environment = { ...process.env };
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    delete environment[name];
  }
  return spawnSync("docker", ["--host=unix:///var/run/docker.sock", ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout,
    maxBuffer: 2_000_000,
    shell: false,
  });
}

test("isolated Compose project ownership is verified without touching unrelated containers", {
  skip: enabled ? false : "set RUN_DOCKER_ADAPTER_INTEGRATION=1 for disposable Docker coverage",
  timeout: 120_000,
}, async () => {
  const project = `fusion_adapter_it_${randomBytes(4).toString("hex")}`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "fusion-adapter-integration-"));
  const baseFile = path.join(directory, "docker-compose.yml");
  const overrideFile = path.join(directory, "docker-compose.ghcr.yml");
  const image = "postgres:16.15-alpine";
  const uiHostPort = await availableLoopbackPort();
  const seccomp = path.resolve("docker/chromium-seccomp.json");
  const applicationService = (cpus, memory, pids, shm) => `
    image: ${image}
    entrypoint: ["sh", "-c", "sleep 300"]
    user: "65534:65534"
    environment: { CHROMIUM_CONCURRENCY: "1" }
    cpus: ${cpus}
    mem_limit: ${memory}
    pids_limit: ${pids}
    shm_size: ${shm}
    security_opt: ["seccomp=${seccomp}"]
    healthcheck: { test: ["CMD-SHELL", "true"], interval: 1s, timeout: 1s, retries: 10 }
    volumes: ["captures:/data"]
    networks: [fusion]`;
  const compose = `name: ${project}
services:
  db:
    image: ${image}
    entrypoint: ["sh", "-c", "sleep 300"]
    user: "65534:65534"
    healthcheck: { test: ["CMD-SHELL", "true"], interval: 1s, timeout: 1s, retries: 10 }
    volumes: ["database:/var/lib/postgresql/data"]
    networks: [fusion]
  api:${applicationService("0.75", "640m", 192, "64m")}
  worker:${applicationService("1.0", "1g", 256, "256m")}
  ui:
    image: ${image}
    entrypoint: ["sh", "-c", "sleep 300"]
    user: "65534:65534"
    ports: ["127.0.0.1:${uiHostPort}:8080"]
    networks: [fusion]
volumes: { database: {}, captures: {} }
networks: { fusion: {} }
`;
  await writeFile(baseFile, compose);
  await writeFile(overrideFile, "services: {}\n");
  const composeArgs = [
    "compose", "--project-directory", directory, "--project-name", project,
    "--file", baseFile, "--file", overrideFile,
  ];
  try {
    const started = docker([...composeArgs, "up", "-d", "--no-build", "--pull", "never"], directory);
    assert.equal(started.status, 0, "disposable Compose project failed to start");
    const adapter = createDockerComposeHostAdapter({
      project,
      projectDirectory: directory,
      composeFiles: [baseFile, overrideFile],
      uiHostPort,
    });
    let containers;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        containers = adapter.inspectProjectContainers();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.deepEqual(Object.keys(containers).sort(), ["api", "db", "ui", "worker"]);
    const scoped = docker([
      "ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}",
    ], directory);
    assert.equal(scoped.status, 0);
    assert.equal(scoped.stdout.trim().split("\n").filter(Boolean).length, 4);
  } finally {
    docker([...composeArgs, "down", "--volumes", "--remove-orphans", "--timeout", "10"], directory);
    let remaining = docker([
      "ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}",
    ], directory);
    const remainingIds = remaining.stdout.trim().split("\n").filter(Boolean);
    if (remainingIds.length) {
      docker(["stop", "--time", "10", ...remainingIds], directory);
      docker(["rm", ...remainingIds], directory);
    }
    const volumeNames = docker([
      "volume", "ls", "--filter", `name=${project}_`, "--format", "{{.Name}}",
    ], directory).stdout.trim().split("\n").filter((name) => name.startsWith(`${project}_`));
    if (volumeNames.length) docker(["volume", "rm", ...volumeNames], directory);
    const networkIds = docker([
      "network", "ls", "--filter", `name=${project}_`, "--format", "{{.ID}} {{.Name}}",
    ], directory).stdout.trim().split("\n").filter((line) => line.split(" ")[1]?.startsWith(`${project}_`))
      .map((line) => line.split(" ")[0]);
    if (networkIds.length) docker(["network", "rm", ...networkIds], directory);
    remaining = docker([
      "ps", "--all", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}",
    ], directory);
    assert.equal(remaining.stdout.trim(), "");
    await rm(directory, { recursive: true, force: true });
  }
});
