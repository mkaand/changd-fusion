#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("./prepare-build-metadata.mjs", import.meta.url));
const shaPattern = /^[0-9a-f]{40}$/i;
const branchPattern = /^(?:|(?!(?:[/.])|.*(?:\.\.|@\{|[~^:?*\\[\]{}\s]))[A-Za-z0-9._/-]{1,255}(?<![/.]))$/;
const prPattern = /^(?:|[1-9]\d*)$/;

function cleanMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Build metadata helper returned invalid output.");
  const { APP_COMMIT, APP_BRANCH, APP_SOURCE_PR } = value;
  if (typeof APP_COMMIT !== "string" || !shaPattern.test(APP_COMMIT)) throw Error("Build metadata helper did not return a verified commit SHA.");
  if (typeof APP_BRANCH !== "string" || !branchPattern.test(APP_BRANCH)) throw Error("Build metadata helper returned an invalid branch.");
  if (typeof APP_SOURCE_PR !== "string" || !prPattern.test(APP_SOURCE_PR)) throw Error("Build metadata helper returned an invalid source PR.");
  return { APP_COMMIT: APP_COMMIT.toLowerCase(), APP_BRANCH, APP_SOURCE_PR };
}

export function prepareUiBuildEnvironment(env = process.env, run = spawnSync) {
  const result = run(process.execPath, [helper, "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) throw Error("Build metadata preparation failed; refusing to start Docker Compose.");
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw Error("Build metadata preparation failed; refusing to start Docker Compose."); }
  const metadata = cleanMetadata(parsed);
  const composeEnv = { ...env };
  // Never permit inherited deployment metadata to survive this verification.
  delete composeEnv.APP_COMMIT;
  delete composeEnv.APP_BRANCH;
  delete composeEnv.APP_SOURCE_PR;
  return { ...composeEnv, ...metadata };
}

export function composeCommandArgs(argv = []) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  return ["compose", ...(args.length ? args : ["build", "ui"])];
}

if (import.meta.main) {
  const env = prepareUiBuildEnvironment();
  const result = spawnSync("docker", composeCommandArgs(process.argv.slice(2)), { env, stdio: "inherit" });
  if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
}
