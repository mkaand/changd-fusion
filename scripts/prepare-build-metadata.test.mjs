import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildMetadataExports, verifiedBuildMetadata } from "./prepare-build-metadata.mjs";
import { composeCommandArgs, prepareUiBuildEnvironment } from "./build-ui-with-metadata.mjs";

const sha = "a".repeat(40);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(testDirectory, "build-ui-with-metadata.mjs");
const git = (args) => args[0] === "rev-parse" ? `${sha}\n` : "master\n";

async function fakeCommands(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "changd-fusion-build-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeGit = path.join(directory, "git");
  const fakeDocker = path.join(directory, "docker");
  const record = path.join(directory, "docker-record.json");

  await writeFile(fakeGit, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.FUSION_TEST_GIT_FAILURE === "1") process.exit(1);
if (args[0] === "rev-parse") {
  process.stdout.write(process.env.FUSION_TEST_INVALID_SHA === "1" ? "invalid\\n" : "${sha}\\n");
  process.exit(0);
}
if (args[0] === "symbolic-ref") {
  if (process.env.FUSION_TEST_DETACHED === "1") process.exit(1);
  process.stdout.write("master\\n");
  process.exit(0);
}
process.exit(1);
`);
  await writeFile(fakeDocker, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FUSION_TEST_DOCKER_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  APP_COMMIT: process.env.APP_COMMIT ?? null,
  APP_BRANCH: process.env.APP_BRANCH ?? null,
  APP_SOURCE_PR: process.env.APP_SOURCE_PR ?? null,
}));
`);
  await Promise.all([chmod(fakeGit, 0o755), chmod(fakeDocker, 0o755)]);
  return { directory, record };
}

function executeWrapper(directory, record, environment = {}) {
  return spawnSync(process.execPath, [wrapper, "--", "up", "-d", "--build"], {
    cwd: testDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
      FUSION_TEST_DOCKER_RECORD: record,
    },
  });
}

test("build metadata is derived from the exact checkout and binds a verified PR", () => {
  assert.deepEqual(verifiedBuildMetadata({ APP_SOURCE_PR: "22", APP_SOURCE_PR_COMMIT: sha }, git), {
    APP_COMMIT: sha, APP_BRANCH: "master", APP_SOURCE_PR: "22",
  });
});

test("build metadata retains a verified commit for a detached checkout", () => {
  const detached = (args) => {
    if (args[0] === "rev-parse") return `${sha}\n`;
    const error = new Error("HEAD is detached");
    error.code = 1;
    throw error;
  };
  assert.deepEqual(verifiedBuildMetadata({ APP_SOURCE_PR: "-1", APP_SOURCE_PR_COMMIT: sha }, detached), {
    APP_COMMIT: sha, APP_BRANCH: "", APP_SOURCE_PR: "",
  });
});

test("build metadata rejects a source PR bound to another checkout", () => {
  assert.equal(verifiedBuildMetadata({ APP_SOURCE_PR: "23", APP_SOURCE_PR_COMMIT: "b".repeat(40) }, git).APP_SOURCE_PR, "");
});

test("detached deployment accepts only a branch bound to its verified checkout", () => {
  const detached = (args) => {
    if (args[0] === "rev-parse") return `${sha}\n`;
    const error = new Error("HEAD is detached"); error.code = 1; throw error;
  };
  assert.equal(verifiedBuildMetadata({ APP_BRANCH_REF: "master", APP_BRANCH_COMMIT: sha }, detached).APP_BRANCH, "master");
  assert.equal(verifiedBuildMetadata({ APP_BRANCH_REF: "master", APP_BRANCH_COMMIT: "b".repeat(40) }, detached).APP_BRANCH, "");
  assert.equal(verifiedBuildMetadata({ APP_BRANCH: "stale", APP_BRANCH_REF: "bad branch", APP_BRANCH_COMMIT: sha }, detached).APP_BRANCH, "");
});

test("wrapper preserves explicit Compose arguments and defaults to one UI build", () => {
  assert.deepEqual(composeCommandArgs([]), ["compose", "build", "ui"]);
  assert.deepEqual(composeCommandArgs(["--", "--env-file", "/private/runtime.env", "-f", "base.yml", "-f", "production.yml", "build", "ui"]), ["compose", "--env-file", "/private/runtime.env", "-f", "base.yml", "-f", "production.yml", "build", "ui"]);
});

test("wrapper accepts only verified helper output and clears stale metadata", () => {
  let received;
  const env = prepareUiBuildEnvironment({
    APP_COMMIT: "f".repeat(40), APP_BRANCH: "stale", APP_SOURCE_PR: "999", KEEP: "yes",
  }, (_command, _args, options) => {
    received = options.env;
    return { status: 0, stdout: JSON.stringify({ APP_COMMIT: sha, APP_BRANCH: "master", APP_SOURCE_PR: "23" }) };
  });
  assert.equal(received.APP_COMMIT, "f".repeat(40));
  assert.equal(env.APP_COMMIT, sha);
  assert.equal(env.APP_BRANCH, "master");
  assert.equal(env.APP_SOURCE_PR, "23");
  assert.equal(env.KEEP, "yes");
});

test("wrapper fails closed before Docker Compose when metadata preparation fails", () => {
  assert.throws(() => prepareUiBuildEnvironment({ APP_COMMIT: "f".repeat(40) }, () => ({ status: 1, stdout: "" })), /refusing to start Docker Compose/);
  assert.throws(() => prepareUiBuildEnvironment({}, () => ({ status: 0, stdout: "not-json" })), /refusing to start Docker Compose/);
});

test("shell export quoting cannot turn metadata into shell syntax", () => {
  const exports = buildMetadataExports({ APP_COMMIT: sha, APP_BRANCH: "feature/o'reilly", APP_SOURCE_PR: "" });
  const output = execFileSync("sh", ["-c", `${exports}\nprintf '%s' \"$APP_BRANCH\"`], { encoding: "utf8" });
  assert.equal(output, "feature/o'reilly");
});

test("wrapper runs a real child process and passes verified metadata to fake Docker", async (t) => {
  const { directory, record } = await fakeCommands(t);
  const result = executeWrapper(directory, record, {
    APP_COMMIT: "f".repeat(40),
    APP_BRANCH: "stale-branch",
    APP_SOURCE_PR: "999",
    APP_SOURCE_PR_COMMIT: "b".repeat(40),
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(await readFile(record, "utf8"));
  assert.deepEqual(observed.args, ["compose", "up", "-d", "--build"]);
  assert.deepEqual(observed, {
    args: ["compose", "up", "-d", "--build"],
    APP_COMMIT: sha,
    APP_BRANCH: "master",
    APP_SOURCE_PR: "",
  });
});

test("wrapper passes a controller-bound branch from a detached checkout", async (t) => {
  const { directory, record } = await fakeCommands(t);
  const result = executeWrapper(directory, record, {
    FUSION_TEST_DETACHED: "1",
    APP_BRANCH: "stale-branch",
    APP_BRANCH_REF: "master",
    APP_BRANCH_COMMIT: sha,
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(await readFile(record, "utf8"));
  assert.equal(observed.APP_COMMIT, sha);
  assert.equal(observed.APP_BRANCH, "master");
  assert.equal(observed.APP_SOURCE_PR, "");
});

test("helper failure prevents fake Docker from starting", async (t) => {
  const { directory, record } = await fakeCommands(t);
  const result = executeWrapper(directory, record, { FUSION_TEST_GIT_FAILURE: "1" });
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(record, "utf8"));
});

test("invalid helper metadata fails closed before fake Docker starts", async (t) => {
  const { directory, record } = await fakeCommands(t);
  const result = executeWrapper(directory, record, { FUSION_TEST_INVALID_SHA: "1" });
  assert.notEqual(result.status, 0);
  await assert.rejects(readFile(record, "utf8"));
});
