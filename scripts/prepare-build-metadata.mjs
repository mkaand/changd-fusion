#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const commitPattern = /^[0-9a-f]{40}$/i;
const branchPattern = /^(?![/.])(?!.*(?:\.\.|@\{|[~^:?*\\[\]{}\s]))[A-Za-z0-9._/-]{1,255}(?<![/.])$/;
const prPattern = /^[1-9]\d*$/;

function verifiedBranch(git) {
  // `git symbolic-ref --quiet HEAD` deliberately exits 1 for a detached
  // checkout. That is valid deployment provenance: retain the verified
  // commit, but do not invent a branch name.
  try { return git(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(); }
  catch { return ""; }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function verifiedBuildMetadata(env, git) {
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim().toLowerCase();
  if (!commitPattern.test(commit)) throw Error("The build checkout does not have a verified commit SHA.");
  const branch = verifiedBranch(git);
  const sourcePr = env.APP_SOURCE_PR ?? "";
  const sourcePrCommit = (env.APP_SOURCE_PR_COMMIT ?? "").trim().toLowerCase();
  return {
    APP_COMMIT: commit,
    APP_BRANCH: branchPattern.test(branch) ? branch : "",
    // A PR number is valid only when the caller explicitly binds it to this
    // exact checkout. The script deliberately never infers PR provenance.
    APP_SOURCE_PR: prPattern.test(sourcePr) && sourcePrCommit === commit ? sourcePr : "",
  };
}

export function buildMetadataExports(metadata) {
  return Object.entries(metadata).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
}

if (import.meta.main) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const metadata = verifiedBuildMetadata(process.env, git);
  console.log(buildMetadataExports(metadata));
}
