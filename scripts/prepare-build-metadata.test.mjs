import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
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
