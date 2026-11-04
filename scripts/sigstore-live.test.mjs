import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyAttestationWithGh } from "./release-trust.mjs";

const requiredEnvironment = [
  "GH_ATTESTATION_BIN",
  "SIGSTORE_TEST_ARTIFACT",
  "SIGSTORE_TEST_BUNDLE",
  "SIGSTORE_TEST_INVALID_BUNDLE",
  "SIGSTORE_TEST_TRUST_ROOT",
];
const missing = requiredEnvironment.filter((name) => !process.env[name]);
const skip = missing.length ? `missing real Sigstore fixture environment: ${missing.join(",")}` : false;
const policy = {
  repository: "sigstore/sigstore-js",
  workflow: ".github/workflows/release.yml",
  sourceSha: "26d16513386ffaa790b1c32f927544f1322e4194",
  sourceRef: "refs/heads/main",
  digestAlgorithm: "sha512",
  subjectDigest: "90f223f992e4c88dd068cd2a5fc57f9d2b30798343dd6e38f29c240e04ba090ef831f84490847c4e82b9232c78e8a258463b1e55c0f7469f730265008fa6633f",
};

const verify = (overrides = {}) => verifyAttestationWithGh({
  subject: overrides.subject ?? process.env.SIGSTORE_TEST_ARTIFACT,
  bundle: overrides.bundle ?? process.env.SIGSTORE_TEST_BUNDLE,
  customTrustedRoot: process.env.SIGSTORE_TEST_TRUST_ROOT,
  ghPath: overrides.ghPath ?? process.env.GH_ATTESTATION_BIN,
  expected: { ...policy, ...overrides.expected },
});

let temporaryDirectory;
let tamperedArtifact;
test.before(async () => {
  if (skip) return;
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "fusion-sigstore-"));
  tamperedArtifact = path.join(temporaryDirectory, "tampered.tgz");
  const original = await readFile(process.env.SIGSTORE_TEST_ARTIFACT);
  await writeFile(tamperedArtifact, Buffer.concat([original, Buffer.from("tampered")]));
});
test.after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("official gh verifier cryptographically verifies signed provenance", { skip }, () => {
  const result = verify();
  assert.equal(result.certificate.issuer, "https://token.actions.githubusercontent.com");
  assert.ok(result.verifiedTimestamps.length > 0);
});

test("official verifier rejects a tampered subject", { skip }, () => {
  assert.throws(() => verify({ subject: tamperedArtifact }), /attestation_verifier_failed/);
});

test("official verifier rejects an invalid signature", { skip }, () => {
  assert.throws(
    () => verify({ bundle: process.env.SIGSTORE_TEST_INVALID_BUNDLE }),
    /attestation_verifier_failed/,
  );
});

test("official verifier rejects mismatched repository and workflow identities", { skip }, () => {
  assert.throws(
    () => verify({ expected: { repository: "sigstore/not-the-repository" } }),
    /attestation_verifier_failed/,
  );
  assert.throws(
    () => verify({ expected: { workflow: ".github/workflows/not-release.yml" } }),
    /attestation_verifier_failed/,
  );
});

test("official verifier rejects a mismatched source commit", { skip }, () => {
  assert.throws(
    () => verify({ expected: { sourceSha: "a".repeat(40) } }),
    /attestation_verifier_failed/,
  );
});

test("verified output parser rejects a mismatched subject digest", { skip }, () => {
  assert.throws(
    () => verify({ expected: { subjectDigest: "a".repeat(128) } }),
    /attestation_claim_mismatch/,
  );
});

test("verification fails closed when the official verifier is missing", { skip }, () => {
  assert.throws(
    () => verify({ ghPath: path.join(temporaryDirectory, "missing-gh") }),
    /attestation_verifier_failed/,
  );
});
