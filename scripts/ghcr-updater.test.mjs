import assert from "node:assert/strict";
import test from "node:test";
import { deploymentPlan, discoverRelease, migrationGate, runUpdater, verifyRelease } from "./ghcr-updater.mjs";

const repository = "mkaand/changd-fusion";
const s = "a".repeat(40), newerSource = "d".repeat(40);
const d = "b".repeat(64), e = "c".repeat(64);

function manifest(sourceSha = s, version = "0.3.3", apiDigest = d, uiDigest = e) {
  const apiImage = `ghcr.io/mkaand/changd-fusion-api@sha256:${apiDigest}`;
  return {
    source_sha: sourceSha,
    version,
    architecture: "linux/amd64",
    api_image: apiImage,
    ui_image: `ghcr.io/mkaand/changd-fusion-ui@sha256:${uiDigest}`,
    api_worker_shared_image: apiImage,
  };
}

function workflow(sourceSha = s, id = 17, overrides = {}) {
  return {
    id,
    name: "GHCR immutable release",
    path: ".github/workflows/ghcr-release.yml",
    status: "completed",
    conclusion: "success",
    head_sha: sourceSha,
    head_branch: "master",
    run_attempt: 1,
    repository,
    ...overrides,
  };
}

const ci = { verify: "success", privacy: "success", docker: "success", "docker-arm64": "success" };
function release({ sourceSha = s, version = "0.3.3", id = 17, run = {}, publisher = {}, apiDigest = d, uiDigest = e } = {}) {
  const releaseManifest = manifest(sourceSha, version, apiDigest, uiDigest);
  return {
    run: workflow(sourceSha, id, run),
    manifest: releaseManifest,
    ci,
    lineage: true,
    publisher: { attested: true, revision: sourceSha, version, ...publisher },
  };
}

function discoveryClient(releases, { calls = [], sourceLineage = true, attestationError } = {}) {
  const byId = new Map(releases.map((item) => [item.run.id, item]));
  return {
    runs: async () => { calls.push("runs"); return releases.map((item) => item.run); },
    manifest: async (run) => { calls.push(`manifest:${run.id}`); return byId.get(run.id).manifest; },
    ci: async (sourceSha) => { calls.push(`ci:${sourceSha}`); return releases.find((item) => item.run.head_sha === sourceSha).ci; },
    masterLineage: async (sourceSha) => { calls.push(`ancestry:${sourceSha}`); return releases.find((item) => item.run.head_sha === sourceSha).lineage; },
    attestation: async (value) => {
      calls.push(`attestation:${value.source_sha}`);
      if (attestationError) throw Error(attestationError);
      return releases.find((item) => item.manifest === value).publisher;
    },
    sourceLineage: async (ancestor, descendant) => {
      calls.push(`source-lineage:${ancestor}:${descendant}`);
      return sourceLineage;
    },
  };
}

const evidence = {
  manifest: manifest(),
  workflow: workflow(),
  masterLineage: true,
  ci,
  publisher: { attested: true, revision: s, version: "0.3.3" },
};

test("accepts only complete attested evidence", () => assert.equal(verifyRelease(evidence, {}).ok, true));

test("rejects replay, downgrade, same-version conflict, bad CI and malformed images", () => {
  assert.equal(verifyRelease(evidence, { source_sha: s }).reason, "replay");
  assert.equal(verifyRelease(evidence, { source_sha: newerSource, version: "0.3.4" }).reason, "downgrade");
  assert.equal(verifyRelease(evidence, { source_sha: newerSource, version: "0.3.3" }).reason, "same_version_conflict");
  assert.equal(verifyRelease({ ...evidence, ci: { ...ci, docker: "failure" } }, {}).reason, "ci_evidence");
  assert.equal(verifyRelease({ ...evidence, manifest: { ...evidence.manifest, ui_image: "latest" } }, {}).reason, "invalid_manifest");
});


test("allows same-version master forward movement only with proof bound to installed SHA", () => {
  const fixture = release({ sourceSha: newerSource, version: "0.3.3" });
  const next = {
    manifest: fixture.manifest, workflow: fixture.run, ci: fixture.ci,
    masterLineage: fixture.lineage, publisher: fixture.publisher,
  };
  const installed = { source_sha: s, version: "0.3.3" };
  assert.equal(verifyRelease(next, installed).reason, "same_version_conflict");
  assert.equal(verifyRelease({
    ...next, installedAncestry: { from: s, to: newerSource, verified: true },
  }, installed).ok, true);
  for (const invalid of [
    { from: newerSource, to: s, verified: true },
    { from: s, to: newerSource, verified: false },
    { from: "f".repeat(40), to: newerSource, verified: true },
  ]) {
    assert.equal(verifyRelease({ ...next, installedAncestry: invalid }, installed).reason, "same_version_conflict");
  }
});

test("accepts one discovered release only after the complete trust chain", async () => {
  const calls = [], item = release();
  const discovered = await discoverRelease(discoveryClient([item], { calls }), { repository });
  assert.deepEqual(calls, ["runs", "manifest:17", `ci:${s}`, `ancestry:${s}`, `attestation:${s}`]);
  assert.equal(discovered.manifest.version, "0.3.3");
  assert.equal(verifyRelease(discovered, {}).ok, true);
});

test("selects the newest of two sequential verified releases independent of API ordering", async () => {
  const older = release(), newer = release({ sourceSha: newerSource, version: "0.3.4", id: 18, apiDigest: "e".repeat(64), uiDigest: "f".repeat(64) });
  for (const listed of [[older, newer], [newer, older]]) {
    const discovered = await discoverRelease(discoveryClient(listed), { repository });
    assert.equal(discovered.manifest.version, "0.3.4");
    assert.equal(discovered.manifest.source_sha, newerSource);
  }
});

test("operator adoption discovers exact historical signed source without substituting newest", async () => {
  const older = release(), newer = release({ sourceSha: newerSource, version: "0.3.4", id: 18,
    apiDigest: "e".repeat(64), uiDigest: "f".repeat(64) });
  const calls = [];
  const selected = await discoverRelease(discoveryClient([newer, older], { calls }), {
    repository, installedSourceSha: s,
  });
  assert.equal(selected.manifest.source_sha, s);
  assert.equal(selected.manifest.api_image, older.manifest.api_image);
  assert.deepEqual(calls, ["runs", "manifest:17", `ci:${s}`, `ancestry:${s}`, `attestation:${s}`]);
  assert.equal(await discoverRelease(discoveryClient([newer]), {
    repository, installedSourceSha: s,
  }), null);
  await assert.rejects(
    discoverRelease(discoveryClient([older]), { repository, installedSourceSha: "wrong" }),
    /invalid_installed_source/,
  );
  await assert.rejects(
    discoverRelease(discoveryClient([{
      ...older, publisher: { ...older.publisher, attested: false },
    }]), { repository, installedSourceSha: s }),
    /publisher_provenance/,
  );
});

test("selects newest ancestor-ordered same-version release and rejects non-ancestral collisions", async () => {
  const older = release(), newerSameVersion = release({
    sourceSha: newerSource, id: 18, apiDigest: "e".repeat(64), uiDigest: "f".repeat(64),
  });
  for (const order of [[older, newerSameVersion], [newerSameVersion, older]]) {
    const selected = await discoverRelease(discoveryClient(order), { repository });
    assert.equal(selected.manifest.source_sha, newerSource);
  }
  await assert.rejects(
    discoverRelease(discoveryClient([older, newerSameVersion], { sourceLineage: false }), { repository }),
    /incompatible_release_ancestry/,
  );
  const newerVersion = {
    ...newerSameVersion,
    manifest: { ...newerSameVersion.manifest, version: "0.3.4" },
    publisher: { ...newerSameVersion.publisher, version: "0.3.4" },
  };
  await assert.rejects(
    discoverRelease(discoveryClient([older, newerVersion], { sourceLineage: false }), { repository }),
    /incompatible_release_ancestry/,
  );
});

test("old successful release with later cancelled CI cannot block current trusted release", async () => {
  const older = release();
  const newer = release({ sourceSha: newerSource, version: "0.3.4", id: 18,
    apiDigest: "e".repeat(64), uiDigest: "f".repeat(64) });
  for (const items of [[older, newer], [newer, older]]) {
    const calls = [], client = discoveryClient(items, { calls });
    const originalCi = client.ci;
    client.ci = (sourceSha) => {
      if (sourceSha === s) throw Error("latest trusted CI workflow run is not successful: completed/cancelled");
      return originalCi(sourceSha);
    };
    const latest = await discoverRelease(client, { repository });
    assert.equal(latest.manifest.source_sha, newerSource);
    assert.equal(calls.filter((value) => value.startsWith("ci:")).join(","), `ci:${newerSource}`);
    assert.equal(calls.filter((value) => value.startsWith("attestation:")).join(","), `attestation:${newerSource}`);
    assert.equal(calls.includes(`source-lineage:${s}:${newerSource}`), true);
  }
});

test("no fallback if newest publisher has invalid CI or attestation", async () => {
  const older = release(), newer = release({ sourceSha: newerSource, id: 18 });
  const candidate = discoveryClient([older, newer]);
  candidate.ci = async (sourceSha) => {
    if (sourceSha === newerSource) throw Error("latest_ci_cancelled");
    return ci;
  };
  await assert.rejects(discoverRelease(candidate, { repository }), /latest_ci_cancelled/);
  const untrusted = release({ sourceSha: newerSource, id: 18, publisher: { attested: false } });
  await assert.rejects(
    discoverRelease(discoveryClient([older, untrusted]), { repository }),
    /publisher_provenance/,
  );
});

test("rejects conflicting published images for one source and duplicate publisher IDs", async () => {
  const older = release(), inconsistent = release({
    sourceSha: s, id: 18, apiDigest: "e".repeat(64), uiDigest: "f".repeat(64),
  });
  await assert.rejects(
    discoverRelease(discoveryClient([older, inconsistent]), { repository }),
    /ambiguous_release_source/,
  );
  await assert.rejects(
    discoverRelease(discoveryClient([older, { ...older }]), { repository }),
    /ambiguous_release_listing/,
  );
});

test("ignores failed runs but rejects an untrusted successful newest candidate", async () => {
  const older = release(), failed = release({ sourceSha: newerSource, version: "0.3.4", id: 18, run: { conclusion: "failure" } });
  assert.equal((await discoverRelease(discoveryClient([failed, older]), { repository })).manifest.version, "0.3.3");
  const untrusted = release({ sourceSha: newerSource, version: "0.3.4", id: 19, publisher: { revision: s } });
  await assert.rejects(discoverRelease(discoveryClient([older, untrusted]), { repository }), /publisher_provenance/);
});

test("fails closed for ambiguous provenance and missing attestation", async () => {
  const ambiguous = release({ publisher: { attested: false } });
  await assert.rejects(discoverRelease(discoveryClient([ambiguous]), { repository }), /publisher_provenance/);
  await assert.rejects(discoverRelease(discoveryClient([release()], { attestationError: "attestation_unavailable" }), { repository }), /attestation_unavailable/);
});

test("returns no release for an empty or entirely failed trusted-run list", async () => {
  assert.equal(await discoverRelease(discoveryClient([]), { repository }), null);
  assert.equal(await discoverRelease(discoveryClient([release({ run: { conclusion: "failure" } })]), { repository }), null);
});

test("dry run validates the project but has zero Docker mutations", async () => {
  let validationCalls = 0, mutationCalls = 0;
  const candidate = { ...evidence.manifest, migrationCompatibility: "forward-safe" };
  const result = await runUpdater({ evidence: { ...evidence, manifest: candidate }, state: {}, config: { project: "fusion", dryRun: true }, docker: { projectIsExpected: async () => { validationCalls++; return true; }, safeDrain: async () => { mutationCalls++; }, compose: async () => { mutationCalls++; } } });
  assert.equal(result.dryRun, true);
  assert.equal(validationCalls, 1);
  assert.equal(mutationCalls, 0);
  assert.equal(deploymentPlan(evidence.manifest, { project: "fusion" }).services.length, 3);
});

test("rejects unsafe migrations", () => {
  assert.equal(migrationGate({ migrationVersion: 2 }, { migrationVersion: 1, migrationCompatibility: "forward-safe" }).reason, "migration_downgrade");
});

test("concurrent updater exits before project or maintenance activity", async () => {
  let calls = 0;
  const result = await runUpdater({ evidence, state: {}, config: { project: "fusion" }, lock: { acquire: async () => false, release: async () => { calls++; } }, docker: { projectIsExpected: async () => { calls++; } } });
  assert.equal(result.reason, "concurrent_updater");
  assert.equal(calls, 0);
});
