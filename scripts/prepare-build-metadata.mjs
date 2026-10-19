#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const commitPattern = /^[0-9a-f]{40}$/i;
const branchPattern = /^(?![/.])(?!.*(?:\.\.|@\{|[~^:?*\\[\]{}\s]))[A-Za-z0-9._/-]{1,255}(?<![/.])$/;
const prPattern = /^[1-9]\d*$/;

export function verifiedBuildMetadata(env, git) {
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim().toLowerCase();
  if (!commitPattern.test(commit)) throw Error("The build checkout does not have a verified commit SHA.");
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
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

if (import.meta.main) {
  const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const metadata = verifiedBuildMetadata(process.env, git);
  for (const [key, value] of Object.entries(metadata)) console.log(`${key}=${JSON.stringify(value)}`);
}
