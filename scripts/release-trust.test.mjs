import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { GitHubReleaseClient } from "./github-release-client.mjs";
import { OciRegistryClient, createGhAttestationVerifier } from "./release-trust.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const source = "a".repeat(40);
const version = "0.3.3";
const config = Buffer.from(JSON.stringify({
  os: "linux",
  architecture: "amd64",
  config: { Labels: {
    "org.opencontainers.image.source": "https://github.com/mkaand/changd-fusion",
    "org.opencontainers.image.revision": source,
    "org.opencontainers.image.version": version,
  } },
}));
const configDigest = `sha256:${hash(config)}`;
const platformManifest = Buffer.from(JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: configDigest,
    size: config.length,
  },
  layers: [],
}));
const platformDigest = `sha256:${hash(platformManifest)}`;
const imageIndex = Buffer.from(JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [{
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: platformDigest,
    size: platformManifest.length,
    platform: { os: "linux", architecture: "amd64" },
  }],
}));
const imageDigest = `sha256:${hash(imageIndex)}`;
const api = `ghcr.io/mkaand/changd-fusion-api@${imageDigest}`;
const ui = `ghcr.io/mkaand/changd-fusion-ui@${imageDigest}`;
const release = {
  source_sha: source,
  version,
  api_image: api,
  ui_image: ui,
  api_worker_shared_image: api,
};

let server;
let baseUrl;
test.before(async () => {
  server = http.createServer((request, response) => {
    if (request.url?.includes(`/manifests/${imageDigest}`)) {
      response.setHeader("content-type", "application/vnd.oci.image.index.v1+json");
      return response.end(imageIndex);
    }
    if (request.url?.includes(`/manifests/${platformDigest}`)) {
      response.setHeader("content-type", "application/vnd.oci.image.manifest.v1+json");
      return response.end(platformManifest);
    }
    if (request.url?.includes(`/blobs/${configDigest}`)) {
      response.setHeader("content-type", "application/vnd.oci.image.config.v1+json");
      return response.end(config);
    }
    // Returning valid bytes for a caller-supplied incorrect digest proves that
    // the client verifies bytes instead of trusting the registry path.
    if (request.url?.includes("/manifests/sha256:")) return response.end(imageIndex);
    response.statusCode = 404;
    return response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("verifies OCI index, manifest and config digests plus release metadata", async () => {
  const result = await new OciRegistryClient({ baseUrl }).verifyReleaseImages(release);
  assert.equal(result.api.digest, imageDigest);
  assert.equal(result.api.manifestDigest, platformDigest);
  assert.equal(result.ui.revision, source);
  assert.equal(result.ui.platform, "linux/amd64");
});

test("rejects manifest digest, metadata and API/Worker identity tampering", async () => {
  const client = new OciRegistryClient({ baseUrl });
  await assert.rejects(
    client.verifyImage(api.replace(imageDigest, `sha256:${"f".repeat(64)}`), release),
    /manifest_digest_mismatch/,
  );
  await assert.rejects(client.verifyImage(api, { ...release, version: "9.9.9" }), /oci_metadata_mismatch/);
  await assert.rejects(
    client.verifyReleaseImages({ ...release, api_worker_shared_image: ui }),
    /api_worker_image_mismatch/,
  );
  const tamperedBlob = new OciRegistryClient({
    baseUrl,
    fetchImpl: (url, options) => url.pathname.includes("/blobs/")
      ? Promise.resolve(new Response(Buffer.concat([config, Buffer.from("tampered")])))
      : fetch(url, options),
  });
  await assert.rejects(tamperedBlob.verifyImage(api, release), /config_digest_mismatch/);
});

test("rejects wrong architecture, HTTP failures, malformed responses and timeouts", async () => {
  const armConfig = Buffer.from(JSON.stringify({
    ...JSON.parse(config),
    architecture: "arm64",
  }));
  const armConfigDigest = `sha256:${hash(armConfig)}`;
  const armManifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: armConfigDigest },
    layers: [],
  }));
  const armDigest = `sha256:${hash(armManifest)}`;
  const armReference = `ghcr.io/mkaand/changd-fusion-api@${armDigest}`;
  const armFetch = async (url) => new Response(
    url.pathname.includes("/blobs/") ? armConfig : armManifest,
    { status: 200 },
  );
  await assert.rejects(
    new OciRegistryClient({ fetchImpl: armFetch }).verifyImage(armReference, release),
    /oci_metadata_mismatch/,
  );
  await assert.rejects(
    new OciRegistryClient({ fetchImpl: async () => new Response("fail", { status: 503 }) })
      .verifyImage(api, release),
    /registry_http_503/,
  );
  const malformed = Buffer.from("not-json");
  const malformedReference = `ghcr.io/mkaand/changd-fusion-api@sha256:${hash(malformed)}`;
  await assert.rejects(
    new OciRegistryClient({ fetchImpl: async () => new Response(malformed) })
      .verifyImage(malformedReference, release),
    /invalid_manifest/,
  );

  const stalled = http.createServer(() => {});
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  try {
    const stalledUrl = `http://127.0.0.1:${stalled.address().port}`;
    await assert.rejects(
      new OciRegistryClient({ baseUrl: stalledUrl, timeoutMs: 20 }).verifyImage(api, release),
      /abort/i,
    );
  } finally {
    await new Promise((resolve) => stalled.close(resolve));
  }
});

function verifiedStatement(reference, overrides = {}) {
  return {
    subject: [{ digest: { sha256: reference.split("@sha256:")[1] } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: {
          repository: "https://github.com/mkaand/changd-fusion",
          path: ".github/workflows/ghcr-release.yml",
          ref: "refs/heads/master",
          ...overrides.workflow,
        } },
        resolvedDependencies: [{ digest: { gitCommit: overrides.source ?? source } }],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
}

test("invokes the official verifier and validates its verified claims", async () => {
  const images = await new OciRegistryClient({ baseUrl }).verifyReleaseImages(release);
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const reference = args.find((value) => value.startsWith("oci://")).slice(6);
    return {
      status: 0,
      stdout: JSON.stringify([{ verificationResult: { statement: verifiedStatement(reference) } }]),
    };
  };
  const client = new GitHubReleaseClient({
    oci: { verifyReleaseImages: async () => images },
    verifier: createGhAttestationVerifier({ spawn, token: "fixture-secret" }),
  });
  const verified = await client.attestation(release);
  assert.equal(verified.attested, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 3), ["attestation", "verify", `oci://${api}`]);
  assert.ok(calls[0].args.includes("--deny-self-hosted-runners"));
  assert.equal(calls[0].args.includes("fixture-secret"), false);
  assert.equal(calls[0].options.env.GH_TOKEN, "fixture-secret");
});

test("rejects invalid signatures, wrong identity, source and subject digest", async () => {
  const images = await new OciRegistryClient({ baseUrl }).verifyReleaseImages(release);
  const context = {
    repository: "mkaand/changd-fusion",
    workflow: ".github/workflows/ghcr-release.yml",
    images,
  };
  await assert.rejects(
    createGhAttestationVerifier({ spawn: () => ({ status: 1, stdout: "" }) })(release, context),
    /attestation_verify_failed/,
  );
  for (const statement of [
    verifiedStatement(api, { workflow: { repository: "https://github.com/evil/repo" } }),
    verifiedStatement(api, { source: "f".repeat(40) }),
    { ...verifiedStatement(api), subject: [{ digest: { sha256: "f".repeat(64) } }] },
  ]) {
    await assert.rejects(
      createGhAttestationVerifier({
        spawn: () => ({
          status: 0,
          stdout: JSON.stringify([{ verificationResult: { statement } }]),
        }),
      })(release, context),
      /attestation_claim_mismatch/,
    );
  }
});

test("release workflow grants attestation permissions and pins official provenance actions", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ghcr-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  const uses = workflow.match(/actions\/attest-build-provenance@[0-9a-f]{40}/g) ?? [];
  assert.equal(uses.length, 2);
  assert.equal(new Set(uses).size, 1);
});
