import assert from "node:assert/strict";
import test from "node:test";
import { verifiedBuildMetadata } from "./prepare-build-metadata.mjs";

const sha = "a".repeat(40);
const git = (args) => args[0] === "rev-parse" ? `${sha}\n` : "master\n";

test("build metadata is derived from the exact checkout and binds a verified PR", () => {
  assert.deepEqual(verifiedBuildMetadata({ APP_SOURCE_PR: "22", APP_SOURCE_PR_COMMIT: sha }, git), {
    APP_COMMIT: sha, APP_BRANCH: "master", APP_SOURCE_PR: "22",
  });
});

test("build metadata omits unverified branch and source PR values", () => {
  const detached = (args) => args[0] === "rev-parse" ? `${sha}\n` : "";
  assert.deepEqual(verifiedBuildMetadata({ APP_SOURCE_PR: "-1", APP_SOURCE_PR_COMMIT: sha }, detached), {
    APP_COMMIT: sha, APP_BRANCH: "", APP_SOURCE_PR: "",
  });
});
