import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import { GitHubReleaseClient } from "./github-release-client.mjs";
import {
  OciRegistryClient,
  createGhAttestationVerifier,
  verifyAttestationWithGh,
} from "./release-trust.mjs";

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


function mockedGhcrReply(url, registryToken) {
  if (url.pathname.includes("/manifests/" + imageDigest)) return new Response(imageIndex);
  if (url.pathname.includes("/manifests/" + platformDigest)) return new Response(platformManifest);
  if (url.pathname.includes("/blobs/" + configDigest)) return new Response(config);
  throw Error("unexpected_fixture_registry_path_" + registryToken);
}

test("negotiates repository-scoped GHCR anonymous bearer and never leaks GitHub API token", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ hostname: url.hostname, pathname: url.pathname, authorization: options.headers.authorization });
    assert.equal(options.redirect, url.hostname === "ghcr.io" && url.pathname.includes("/blobs/") ? "manual" : "error");
    if (url.pathname === "/token") {
      assert.equal(url.hostname, "ghcr.io");
      assert.equal(url.searchParams.get("service"), "ghcr.io");
      assert.match(url.searchParams.get("scope"), /^repository:mkaand\/changd-fusion-(api|ui):pull$/);
      assert.equal(options.headers.authorization, undefined, "anonymous token exchange must not leak API token");
      return new Response(JSON.stringify({ token: "scoped-public-registry-token" }));
    }
    const repository = /^\/v2\/(mkaand\/changd-fusion-(?:api|ui))\//.exec(url.pathname)?.[1];
    assert.ok(repository);
    if (!options.headers.authorization) {
      return new Response("", { status: 401, headers: {
        "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:' + repository + ':pull"',
      } });
    }
    assert.equal(options.headers.authorization, "Bearer scoped-public-registry-token");
    return mockedGhcrReply(url);
  };
  const client = new OciRegistryClient({ fetchImpl, token: "existing-github-api-token" });
  const result = await client.verifyReleaseImages(release);
  assert.equal(result.api.digest, imageDigest);
  assert.equal(result.ui.digest, imageDigest);
  assert.equal(calls.filter((call) => call.pathname === "/token").length, 6);
  assert.equal(calls.some((call) => String(call.authorization).includes("existing-github-api-token")), false);
});

test("private GHCR pull may reuse existing token only at pinned GHCR token endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, authorization: options.headers.authorization });
    if (url.pathname === "/token") {
      const authorization = options.headers.authorization;
      if (authorization) {
        assert.equal(Buffer.from(authorization.slice(6), "base64").toString("utf8"), "mkaand:existing-authorized-token");
        return new Response(JSON.stringify({ access_token: "scoped-private-token" }));
      }
      return new Response(JSON.stringify({ token: "scoped-anonymous-token" }));
    }
    const repository = /^\/v2\/(mkaand\/changd-fusion-(?:api|ui))\//.exec(url.pathname)?.[1];
    if (!options.headers.authorization) {
      return new Response("", { status: 401, headers: {
        "www-authenticate": 'Bearer scope="repository:' + repository + ':pull",service="ghcr.io",realm="https://ghcr.io/token"',
      } });
    }
    if (options.headers.authorization === "Bearer scoped-anonymous-token") return new Response("denied", { status: 403 });
    assert.equal(options.headers.authorization, "Bearer scoped-private-token");
    return mockedGhcrReply(url);
  };
  const result = await new OciRegistryClient({ fetchImpl, token: "existing-authorized-token" }).verifyReleaseImages(release);
  assert.equal(result.ui.revision, source);
  assert.equal(calls.some((call) => call.authorization?.startsWith("Basic ") && !call.url.startsWith("https://ghcr.io/token?")), false);
});

test("rejects rogue token issuers, wrong repository scopes, malformed token bodies and denied access", async () => {
  for (const challenge of [
    'Bearer realm="https://evil.invalid/token",service="ghcr.io",scope="repository:mkaand/changd-fusion-api:pull"',
    'Bearer realm="https://ghcr.io/token",service="evil.invalid",scope="repository:mkaand/changd-fusion-api:pull"',
    'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:mkaand/changd-fusion-ui:pull"',
    'Basic realm="https://ghcr.io/token",service="ghcr.io",scope="repository:mkaand/changd-fusion-api:pull"',
  ]) {
    let tokenCalls = 0;
    const fetchImpl = async (url) => {
      if (url.pathname === "/token") tokenCalls++;
      return new Response("", { status: 401, headers: { "www-authenticate": challenge } });
    };
    await assert.rejects(new OciRegistryClient({ fetchImpl, token: "existing-secret" }).verifyImage(api, release), /untrusted_registry_challenge/);
    assert.equal(tokenCalls, 0);
  }

  const challenge = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:mkaand/changd-fusion-api:pull"';
  const tokenFail = async (url) => url.pathname === "/token"
    ? new Response(JSON.stringify({ token: "bad\nvalue" }))
    : new Response("", { status: 401, headers: { "www-authenticate": challenge } });
  await assert.rejects(new OciRegistryClient({ fetchImpl: tokenFail }).verifyImage(api, release), /invalid_registry_token_response/);
  const denied = async (url, options) => url.pathname === "/token"
    ? new Response(JSON.stringify({ token: "scoped" }))
    : options.headers.authorization
      ? new Response("denied", { status: 403 })
      : new Response("", { status: 401, headers: { "www-authenticate": challenge } });
  await assert.rejects(new OciRegistryClient({ fetchImpl: denied }).verifyImage(api, release), /registry_http_403/);
});


test("private GHCR token-service denial falls back to the already configured token", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: url.href, authorization: options.headers.authorization });
    if (url.pathname === "/token") {
      if (!options.headers.authorization) return new Response("no anonymous access", { status: 403 });
      assert.equal(Buffer.from(options.headers.authorization.slice(6), "base64").toString("utf8"), "mkaand:previously-configured-token");
      return new Response(JSON.stringify({ token: "authorized-scoped-registry-token" }));
    }
    const repository = /^\/v2\/(mkaand\/changd-fusion-(?:api|ui))\//.exec(url.pathname)?.[1];
    if (!options.headers.authorization) return new Response("", { status: 401, headers: {
      "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:' + repository + ':pull"',
    } });
    assert.equal(options.headers.authorization, "Bearer authorized-scoped-registry-token");
    return mockedGhcrReply(url);
  };
  const result = await new OciRegistryClient({ fetchImpl, token: "previously-configured-token" }).verifyReleaseImages(release);
  assert.equal(result.api.digest, imageDigest);
  assert.equal(calls.some((call) => call.authorization?.startsWith("Basic ") && !call.url.startsWith("https://ghcr.io/token?")), false);
});

test("real Node fetch exposes GHCR 307 blob redirect to manual policy without leaking credentials", async () => {
  let redirectedTarget = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/" + configDigest + "?signed=fixture";
  const requests = [];
  const localRegistry = http.createServer((req, res) => {
    const authorization = req.headers.authorization;
    requests.push({ path: req.url, authorization });
    const repository = req.url?.split("/").slice(2, 4).join("/");
    if (!authorization) {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:' + repository + ':pull"' });
      return res.end();
    }
    if (authorization !== "Bearer scope-only") { res.writeHead(403); return res.end(); }
    if (req.url.includes("/manifests/" + imageDigest)) return res.end(imageIndex);
    if (req.url.includes("/manifests/" + platformDigest)) return res.end(platformManifest);
    if (req.url.includes("/blobs/" + configDigest)) {
      res.writeHead(307, { location: redirectedTarget });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => localRegistry.listen(0, "127.0.0.1", resolve));
  const localUrl = "http://127.0.0.1:" + localRegistry.address().port;
  const storage = [];
  const fetchImpl = (url, options) => {
    if (url.hostname === "ghcr.io" && url.pathname === "/token") {
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.authorization, undefined);
      return Promise.resolve(new Response(JSON.stringify({ token: "scope-only" })));
    }
    if (url.hostname === "pkg-containers.githubusercontent.com") {
      storage.push({ redirect: options.redirect, authorization: options.headers.authorization });
      return Promise.resolve(new Response(config));
    }
    return fetch(url, options);
  };
  try {
    const client = new OciRegistryClient({ baseUrl: localUrl, fetchImpl });
    const verified = await client.verifyImage(api, release);
    assert.equal(verified.configDigest, configDigest);
    assert.ok(requests.some((request) => request.path.includes("/blobs/") && request.authorization === "Bearer scope-only"));
    assert.deepEqual(storage, [{ redirect: "error", authorization: undefined }]);
    redirectedTarget = "https://evil.invalid/steal";
    await assert.rejects(client.verifyImage(api, release), /untrusted_registry_blob_redirect/);
    assert.equal(storage.length, 1, "malicious redirect must not be followed");
  } finally {
    await new Promise((resolve) => localRegistry.close(resolve));
  }
});

test("handles GHCR blob redirects without forwarding tokens and retains digest verification", async () => {
  const redirectUrl = "https://pkg-containers.githubusercontent.com/ghcr1/blobs/" + configDigest + "?signature=fixture";
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ host: url.hostname, authorization: options.headers.authorization });
    assert.equal(options.redirect, url.hostname === "ghcr.io" && url.pathname.includes("/blobs/") ? "manual" : "error");
    if (url.hostname === "pkg-containers.githubusercontent.com") {
      assert.equal(options.headers.authorization, undefined);
      assert.equal(options.redirect, "error");
      return new Response(config);
    }
    if (url.pathname === "/token") return new Response(JSON.stringify({ token: "scoped-read" }));
    const repository = /^\/v2\/(mkaand\/changd-fusion-(?:api|ui))\//.exec(url.pathname)?.[1];
    if (!options.headers.authorization) return new Response("", { status: 401, headers: {
      "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:' + repository + ':pull"',
    } });
    if (url.pathname.includes("/blobs/")) {
      return new Response(null, { status: 307, headers: { location: redirectUrl } });
    }
    return mockedGhcrReply(url);
  };
  const result = await new OciRegistryClient({ fetchImpl, token: "existing-github-token" }).verifyReleaseImages(release);
  assert.equal(result.api.configDigest, configDigest);
  assert.ok(calls.some((call) => call.host === "pkg-containers.githubusercontent.com"));

  const poisoned = async (url, options) => {
    if (url.pathname === "/token") return new Response(JSON.stringify({ token: "scoped-read" }));
    const repository = /^\/v2\/(mkaand\/changd-fusion-(?:api|ui))\//.exec(url.pathname)?.[1];
    if (!options.headers.authorization) return new Response("", { status: 401, headers: {
      "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:' + repository + ':pull"',
    } });
    if (url.pathname.includes("/blobs/")) return new Response(null, { status: 307, headers: { location: "https://evil.invalid/steal" } });
    return mockedGhcrReply(url);
  };
  await assert.rejects(new OciRegistryClient({ fetchImpl: poisoned }).verifyImage(api, release), /untrusted_registry_blob_redirect/);

  const tampered = async (url, options) => {
    if (url.hostname === "pkg-containers.githubusercontent.com") return new Response(Buffer.concat([config, Buffer.from("tampered")]));
    if (url.pathname === "/token") return new Response(JSON.stringify({ token: "scoped-read" }));
    const repository = /^\/v2\/(mkaand\/changd-fusion-(?:api|ui))\//.exec(url.pathname)?.[1];
    if (!options.headers.authorization) return new Response("", { status: 401, headers: {
      "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:' + repository + ':pull"',
    } });
    if (url.pathname.includes("/blobs/")) return new Response(null, { status: 307, headers: { location: redirectUrl } });
    return mockedGhcrReply(url);
  };
  await assert.rejects(new OciRegistryClient({ fetchImpl: tampered }).verifyImage(api, release), /config_digest_mismatch/);
});

function verifiedResult(reference, overrides = {}) {
  const repository = overrides.repository ?? "mkaand/changd-fusion";
  const workflowPath = ".github/workflows/ghcr-release.yml";
  const sourceRef = "refs/heads/master";
  const sourceSha = overrides.source ?? source;
  const repositoryUrl = `https://github.com/${repository}`;
  const signerUri = `${repositoryUrl}/${workflowPath}@${sourceRef}`;
  const statement = {
    subject: [{ digest: { sha256: overrides.subjectDigest ?? reference.split("@sha256:")[1] } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: {
          repository: repositoryUrl,
          path: workflowPath,
          ref: sourceRef,
          ...overrides.workflow,
        } },
        resolvedDependencies: [{ digest: { gitCommit: sourceSha } }],
      },
      // Exact structure emitted by the successful GHCR immutable-release
      // action's SLSA workflow/v1 predicate on production.
      runDetails: { builder: { id: overrides.builder ?? signerUri } },
    },
  };
  return [{ verificationResult: {
    signature: { certificate: {
      issuer: "https://token.actions.githubusercontent.com",
      githubWorkflowRepository: repository,
      githubWorkflowRef: sourceRef,
      buildSignerURI: signerUri,
      runnerEnvironment: "github-hosted",
      sourceRepositoryURI: repositoryUrl,
      sourceRepositoryDigest: sourceSha,
      sourceRepositoryRef: sourceRef,
      buildConfigURI: signerUri,
      ...overrides.certificate,
    } },
    verifiedTimestamps: overrides.timestamps ?? [{ type: "transparency-log" }],
    statement: overrides.statement ?? statement,
  } }];
}

test("invokes the official verifier and validates its verified claims", async () => {
  const images = await new OciRegistryClient({ baseUrl }).verifyReleaseImages(release);
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "--version") return { status: 0, stdout: "gh version 2.103.3 (fixture)\n" };
    const reference = args.find((value) => value.startsWith("oci://")).slice(6);
    return {
      status: 0,
      stdout: JSON.stringify(verifiedResult(reference)),
    };
  };
  const client = new GitHubReleaseClient({
    oci: { verifyReleaseImages: async () => images },
    verifier: createGhAttestationVerifier({ spawn, token: "fixture-secret" }),
  });
  const verified = await client.attestation(release);
  assert.equal(verified.attested, true);
  const realWorldFixture = verifiedResult(api)[0].verificationResult;
  assert.equal(realWorldFixture.statement.predicate.runDetails.builder.id,
    "https://github.com/mkaand/changd-fusion/.github/workflows/ghcr-release.yml@refs/heads/master");
  const verificationCalls = calls.filter((call) => call.args[0] === "attestation");
  assert.equal(verificationCalls.length, 2);
  assert.deepEqual(verificationCalls[0].args.slice(0, 3), ["attestation", "verify", `oci://${api}`]);
  assert.ok(verificationCalls[0].args.includes("--deny-self-hosted-runners"));
  assert.ok(verificationCalls[0].args.includes("mkaand/changd-fusion/.github/workflows/ghcr-release.yml"));
  assert.ok(verificationCalls[0].args.includes(source));
  assert.equal(verificationCalls[0].args.includes("fixture-secret"), false);
  assert.equal(verificationCalls[0].options.env.GH_TOKEN, "fixture-secret");
});

test("rejects invalid signatures, wrong identity, source and subject digest", async () => {
  const images = await new OciRegistryClient({ baseUrl }).verifyReleaseImages(release);
  const context = {
    repository: "mkaand/changd-fusion",
    workflow: ".github/workflows/ghcr-release.yml",
    images,
  };
  const version = { status: 0, stdout: "gh version 2.103.3 (fixture)\n" };
  await assert.rejects(createGhAttestationVerifier({
    spawn: (_command, args) => args[0] === "--version" ? version : { status: 1, stdout: "" },
  })(release, context), /attestation_verifier_failed/);
  for (const output of [
    verifiedResult(api, { repository: "evil/repo" }),
    verifiedResult(api, { source: "f".repeat(40) }),
    verifiedResult(api, { subjectDigest: "f".repeat(64) }),
    verifiedResult(api, { builder: "https://github.com/actions/runner/github-hosted" }),
    verifiedResult(api, { builder: "https://github.com/evil/repo/.github/workflows/release.yml@refs/heads/master" }),
    verifiedResult(api, { certificate: { runnerEnvironment: "self-hosted" } }),
    verifiedResult(api, { timestamps: [] }),
  ]) {
    await assert.rejects(
      createGhAttestationVerifier({
        spawn: (_command, args) => args[0] === "--version"
          ? version
          : { status: 0, stdout: JSON.stringify(output) },
      })(release, context),
      /attestation_claim_mismatch|incomplete_verified_attestation/,
    );
  }
  for (const [stdout, error] of [
    ["not-json", /invalid_attestation_output/],
    ["[]", /ambiguous_attestation/],
    [JSON.stringify([...verifiedResult(api), ...verifiedResult(api)]), /ambiguous_attestation/],
  ]) {
    await assert.rejects(
      createGhAttestationVerifier({
        spawn: (_command, args) => args[0] === "--version"
          ? version
          : { status: 0, stdout },
      })(release, context),
      error,
    );
  }
  assert.throws(() => verifyAttestationWithGh({
    subject: `oci://${api}`,
    expected: {
      repository: "mkaand/changd-fusion",
      workflow: ".github/workflows/ghcr-release.yml",
      sourceSha: source,
      sourceRef: "refs/heads/master",
      digestAlgorithm: "sha256",
      subjectDigest: imageDigest.slice(7),
    },
    spawn: () => ({ status: 0, stdout: "gh version 2.46.0 (old)\n" }),
  }),
    /unsupported_gh_attestation_version/,
  );
});

test("release workflow grants attestation permissions and pins official provenance actions", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ghcr-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows: \[CI\]/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch == 'master'/);
  assert.match(workflow, /SOURCE_SHA:.*workflow_run\.head_sha/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  const uses = workflow.match(/actions\/attest-build-provenance@[0-9a-f]{40}/g) ?? [];
  assert.equal(uses.length, 2);
  assert.equal(new Set(uses).size, 1);
  const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /version=2\.103\.3/);
  assert.match(ci, /node --test scripts\/sigstore-live\.test\.mjs/);
  assert.match(ci, /permissions:\n\s+contents: read/);
});
