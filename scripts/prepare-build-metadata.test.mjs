import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMetadataExports, verifiedBuildMetadata } from "./prepare-build-metadata.mjs";

const sha = "a".repeat(40);
const git = (args) => args[0] === "rev-parse" ? `${sha}\n` : "master\n";

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

test("shell output exports verified metadata to a real child process", () => {
  const script = fileURLToPath(new URL("./prepare-build-metadata.mjs", import.meta.url));
  const sourcePrCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8" }).trim();
  let expectedBranch = "";
  try { expectedBranch = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  const output = execFileSync("sh", ["-c", 'eval "$(node \"$1\")"; node -e \'process.stdout.write(JSON.stringify({commit:process.env.APP_COMMIT,branch:process.env.APP_BRANCH,pr:process.env.APP_SOURCE_PR}))\'', "sh", script], {
    encoding: "utf8",
    env: { ...process.env, APP_SOURCE_PR: "23", APP_SOURCE_PR_COMMIT: sourcePrCommit },
  });
  const values = JSON.parse(output);
  assert.equal(values.commit, sourcePrCommit);
  assert.equal(values.branch, expectedBranch, "the child process preserves detached-HEAD provenance without inventing a branch");
  assert.equal(values.pr, "23");
  assert.match(buildMetadataExports({ APP_COMMIT: sha, APP_BRANCH: "master", APP_SOURCE_PR: "" }), /^export APP_COMMIT=/m);
});

test("shell export quoting cannot turn metadata into shell syntax", () => {
  const exports = buildMetadataExports({ APP_COMMIT: sha, APP_BRANCH: "feature/o'reilly", APP_SOURCE_PR: "" });
  const output = execFileSync("sh", ["-c", `${exports}\nprintf '%s' \"$APP_BRANCH\"`], { encoding: "utf8" });
  assert.equal(output, "feature/o'reilly");
});

test("metadata wrapper fails closed and clears stale exports before starting Compose", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusion-build-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "compose-env.json");
  const docker = path.join(root, "docker");
  await writeFile(docker, `#!/bin/sh\nprintf '%s' \"{\\\"commit\\\":\\\"$APP_COMMIT\\\",\\\"branch\\\":\\\"$APP_BRANCH\\\",\\\"pr\\\":\\\"$APP_SOURCE_PR\\\"}\" > \"$FUSION_COMPOSE_MARKER\"\n`);
  await chmod(docker, 0o755);
  const wrapper = fileURLToPath(new URL("./build-ui-with-metadata.mjs", import.meta.url));
  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8" }).trim();
  const inherited = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    FUSION_COMPOSE_MARKER: marker,
    APP_COMMIT: "f".repeat(40), APP_BRANCH: "stale-branch", APP_SOURCE_PR: "999", APP_SOURCE_PR_COMMIT: commit,
  };
  const success = spawnSync(process.execPath, [wrapper], { cwd: path.resolve(import.meta.dirname, ".."), env: inherited, encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  const values = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(values.commit, commit);
  assert.notEqual(values.commit, "f".repeat(40));
  assert.equal(values.pr, "999");

  const failureMarker = path.join(root, "compose-ran-after-failure");
  const failure = spawnSync(process.execPath, [wrapper], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...inherited, FUSION_COMPOSE_MARKER: failureMarker, GIT_DIR: path.join(root, "missing-git") },
    encoding: "utf8",
  });
  assert.notEqual(failure.status, 0);
  await assert.rejects(readFile(failureMarker), /ENOENT/, "Compose must not run after helper failure, even with stale APP_* values");
});
