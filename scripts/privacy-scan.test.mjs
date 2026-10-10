import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
const scanner = path.resolve("scripts/privacy-scan.mjs");
test("privacy scan rejects removed historical credentials without printing their values", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fusion-privacy-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const commit = () =>
    git(
      "-c",
      "user.name=codex",
      "-c",
      "user.email=codex@openai.com",
      "commit",
      "-qm",
      "Synthetic scanner fixture\n\nCo-Authored-By: codex <codex@openai.com>",
    );
  try {
    git("init", "-q");
    writeFileSync(path.join(root, "fixture.txt"), "https://example.com\n");
    git("add", ".");
    commit();
    const base = git("rev-parse", "HEAD").toString().trim();
    const secret = "ghp_" + "x".repeat(40);
    writeFileSync(path.join(root, "fixture.txt"), secret);
    git("add", ".");
    commit();
    writeFileSync(path.join(root, "fixture.txt"), "https://example.com\n");
    git("add", ".");
    commit();
    assert.equal(
      spawnSync(process.execPath, [scanner], { cwd: root }).status,
      0,
    );
    const result = spawnSync(process.execPath, [scanner, "--history=" + base], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GitHub token/);
    assert.ok(!result.stderr.includes(secret));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("privacy scan checks untracked files, artifacts and locally supplied identifiers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fusion-privacy-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(path.join(root, "fixture.txt"), "synthetic-private-marker");
    const result = spawnSync(process.execPath, [scanner], {
      cwd: root,
      env: {
        ...process.env,
        PRIVACY_FORBIDDEN_SUBSTRINGS: "synthetic-private-marker",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden private identifier/);
    assert.ok(!result.stderr.includes("synthetic-private-marker"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
