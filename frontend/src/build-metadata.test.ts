import { expect, it } from "vitest";
import { normalizeBuildMetadata } from "./build-metadata";

it("accepts complete, verifiable public build metadata", () => {
  expect(normalizeBuildMetadata({
    version: "0.2.0",
    commit: "A".repeat(40),
    branch: "feature/chromium-targeted-optimizations-visual-compare",
    sourcePr: "20",
  })).toEqual({
    version: "0.2.0",
    commit: "a".repeat(40),
    branch: "feature/chromium-targeted-optimizations-visual-compare",
    sourcePr: 20,
  });
});

it("fails closed for incomplete or malformed commit, branch, and PR metadata", () => {
  expect(normalizeBuildMetadata({
    version: "",
    commit: "not-a-commit",
    branch: "feature branch",
    sourcePr: "0",
  })).toEqual({ version: null, commit: null, branch: null, sourcePr: null });
});
