#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const commitPattern = /^[0-9a-f]{40}$/i;
const branchPattern = /^(?![/.])(?!.*(?:\.\.|@\{|[~^:?*\\[\]{}\s]))[A-Za-z0-9._/-]{1,255}(?<![/.])$/;
const prPattern = /^[1-9]\d*$/;

function verifiedBranch(env, git, commit) {
  // A checked-out symbolic ref is local Git evidence and takes precedence.
  try {
    const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
    if (branchPattern.test(branch)) return branch;
  } catch {}
  // Deployment controllers may use a detached, immutable checkout. They may
  // supply the branch only when they bind it to this exact verified commit.
  const branch = (env.APP_BRANCH_REF ?? "").trim();
  const branchCommit = (env.APP_BRANCH_COMMIT ?? "").trim().toLowerCase();
  return branchPattern.test(branch) && branchCommit === commit ? branch : "";
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function verifiedBuildMetadata(env, git) {
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim().toLowerCase();
  if (!commitPattern.test(commit)) throw Error("The build checkout does not have a verified commit SHA.");
  const branch = verifiedBranch(env, git, commit);
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
  if (process.argv[2] === "--json") console.log(JSON.stringify(metadata));
  else if (!process.argv[2]) console.log(buildMetadataExports(metadata));
  else throw Error("Unsupported build metadata output format");
}
