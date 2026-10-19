import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { buildMetadataExports, verifiedBuildMetadata } from "./prepare-build-metadata.mjs";
import { composeCommandArgs, prepareUiBuildEnvironment } from "./build-ui-with-metadata.mjs";

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
