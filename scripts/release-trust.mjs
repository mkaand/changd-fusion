import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const IMAGE_REFERENCE = /^ghcr\.io\/mkaand\/changd-fusion-(api|ui)@sha256:([0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_REGISTRY_RESPONSE = 2_000_000;
const MAX_REGISTRY_TOKEN_RESPONSE = 8192;
const GHCR_TOKEN_URL = "https://ghcr.io/token";
const OCI_READ_PATH = /^\/v2\/(mkaand\/changd-fusion-(?:api|ui))\/(?:manifests|blobs)\/sha256:[0-9a-f]{64}$/;

// GitHub Actions API tokens are not GHCR registry bearer tokens. Only a
// repository-scoped token from a pinned GHCR challenge may authorize reads.
function parseGhcrChallenge(header, path) {
  const repository = OCI_READ_PATH.exec(path)?.[1];
  if (!repository || typeof header !== "string" || !/^Bearer\s/.test(header)) {
    throw Error("untrusted_registry_challenge");
  }
  const parameters = header.replace(/^Bearer\s+/, "");
  const expression = /([a-z][a-z-]*)="([^"\r\n]*)"/g;
  const entries = [...parameters.matchAll(expression)];
  const extra = parameters.replace(expression, "").replace(/[\s,]/g, "");
  if (entries.length !== 3 || extra) throw Error("untrusted_registry_challenge");
  const attributes = new Map(entries.map((entry) => [entry[1], entry[2]]));
  if (attributes.size !== 3 || attributes.get("realm") !== GHCR_TOKEN_URL
    || attributes.get("service") !== "ghcr.io"
    || attributes.get("scope") !== "repository:" + repository + ":pull") {
    throw Error("untrusted_registry_challenge");
  }
  return { service: "ghcr.io", scope: "repository:" + repository + ":pull" };
}

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
export const SUPPORTED_GH_ATTESTATION_VERSION = "2.103.3";

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export class OciRegistryClient {
  constructor({
    baseUrl = "https://ghcr.io",
    token,
    fetchImpl = fetch,
    timeoutMs = 10_000,
    maxResponseBytes = MAX_REGISTRY_RESPONSE,
  } = {}) {
    this.baseUrl = new URL(baseUrl);
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    if (this.baseUrl.protocol !== "https:" && this.baseUrl.hostname !== "127.0.0.1") {
      throw Error("untrusted_registry_origin");
    }
  }

  async scopedRegistryToken(challenge, authenticated = false) {
    // The token issuer and pull scope have already been verified. Public GHCR
    // packages need no credentials; private packages may reuse an existing
    // token solely at ghcr.io/token, without any credential file mutation.
    if (authenticated && !this.token) throw Error("registry_credentials_unavailable");
    const url = new URL(GHCR_TOKEN_URL);
    url.searchParams.set("service", challenge.service);
    url.searchParams.set("scope", challenge.scope);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { accept: "application/json" };
      if (authenticated) {
        headers.authorization = "Basic " + Buffer.from("mkaand:" + this.token).toString("base64");
      }
      const response = await this.fetch(url, { redirect: "error", signal: controller.signal, headers });
      if (!response.ok) throw Error("registry_token_http_" + response.status);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_REGISTRY_TOKEN_RESPONSE) {
        throw Error("invalid_registry_token_response");
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_REGISTRY_TOKEN_RESPONSE) throw Error("invalid_registry_token_response");
      let data;
      try { data = JSON.parse(bytes.toString("utf8")); }
      catch { throw Error("invalid_registry_token_response"); }
      const token = data?.token ?? data?.access_token;
      if (typeof token !== "string" || token.length < 1 || token.length > 8192
        || !/^[\x21-\x7e]+$/.test(token)) throw Error("invalid_registry_token_response");
      return token;
    } finally {
      clearTimeout(timer);
    }
  }

  async bytes(path, accept) {
    if (!OCI_READ_PATH.test(path)) throw Error("invalid_registry_path");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const request = (registryToken) => this.fetch(new URL(path, this.baseUrl), {
        redirect: "error",
        signal: controller.signal,
        headers: { accept, ...(registryToken ? { authorization: "Bearer " + registryToken } : {}) },
      });
      // Never send the GitHub Actions token directly to the OCI registry.
      let response = await request();
      if (response.status === 401) {
        const challenge = parseGhcrChallenge(response.headers.get("www-authenticate"), path);
        let scopedToken;
        let authenticated = false;
        try {
          scopedToken = await this.scopedRegistryToken(challenge);
        } catch (error) {
          if (!this.token || !/^registry_token_http_(401|403)$/.test(error?.message ?? "")) throw error;
          scopedToken = await this.scopedRegistryToken(challenge, true);
          authenticated = true;
        }
        response = await request(scopedToken);
        if ([401, 403].includes(response.status) && this.token && !authenticated) {
          response = await request(await this.scopedRegistryToken(challenge, true));
        }
      }
      // OCI blob reads may redirect to signed GitHub package storage. Follow
      // only one allowlisted HTTPS hop, without forwarding any credentials.
      // The caller still checks the final bytes against the immutable digest.
      if ([302, 307].includes(response.status) && path.includes("/blobs/")) {
        const location = response.headers.get("location");
        let target;
        try { target = new URL(location); }
        catch { throw Error("untrusted_registry_blob_redirect"); }
        const trustedHost = target.hostname === "pkg-containers.githubusercontent.com"
          || (target.hostname.endsWith(".blob.core.windows.net") && target.hostname.length > ".blob.core.windows.net".length);
        if (!trustedHost || target.protocol !== "https:" || target.username || target.password || target.port) {
          throw Error("untrusted_registry_blob_redirect");
        }
        response = await this.fetch(target, {
          redirect: "error",
          signal: controller.signal,
          headers: { accept },
        });
      }
      if (!response.ok) throw Error("registry_http_" + response.status);
      const lengthHeader = response.headers.get("content-length");
      const declared = lengthHeader === null ? null : Number(lengthHeader);
      if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) {
        throw Error("invalid_registry_content_length");
      }
      if (declared !== null && declared > this.maxResponseBytes) {
        throw Error("registry_response_too_large");
      }
      if (!response.body) return Buffer.alloc(0);
      const chunks = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > this.maxResponseBytes) {
          controller.abort();
          throw Error("registry_response_too_large");
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, total);
    } finally {
      clearTimeout(timer);
    }
  }

  async verifiedJson(path, wantedDigest, accept, errorName) {
    const body = await this.bytes(path, accept);
    if (sha256(body) !== wantedDigest) throw Error(`${errorName}_digest_mismatch`);
    try {
      return { value: JSON.parse(body.toString("utf8")), body };
    } catch {
      throw Error(`invalid_${errorName}`);
    }
  }

  async verifyImage(reference, expected) {
    const match = IMAGE_REFERENCE.exec(reference);
    if (!match) throw Error("invalid_image_reference");
    const repository = `mkaand/changd-fusion-${match[1]}`;
    const requestedDigest = `sha256:${match[2]}`;
    const accept = [OCI_INDEX, DOCKER_INDEX, OCI_MANIFEST, DOCKER_MANIFEST].join(", ");
    const root = await this.verifiedJson(
      `/v2/${repository}/manifests/${requestedDigest}`,
      requestedDigest,
      accept,
      "manifest",
    );

    let manifest = root.value;
    let manifestDigest = requestedDigest;
    if ([OCI_INDEX, DOCKER_INDEX].includes(manifest.mediaType)) {
      if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.manifests)) {
        throw Error("unsupported_oci_index");
      }
      const candidates = manifest.manifests.filter(
        (entry) => entry?.platform?.os === "linux"
          && entry?.platform?.architecture === "amd64"
          && DIGEST.test(entry?.digest ?? ""),
      );
      if (candidates.length !== 1) throw Error("ambiguous_amd64_manifest");
      manifestDigest = candidates[0].digest;
      manifest = (await this.verifiedJson(
        `/v2/${repository}/manifests/${manifestDigest}`,
        manifestDigest,
        `${OCI_MANIFEST}, ${DOCKER_MANIFEST}`,
        "platform_manifest",
      )).value;
    }

    if (manifest.schemaVersion !== 2
      || ![OCI_MANIFEST, DOCKER_MANIFEST].includes(manifest.mediaType)
      || !DIGEST.test(manifest.config?.digest ?? "")) {
      throw Error("unsupported_oci_manifest");
    }
    const configDigest = manifest.config.digest;
    const config = (await this.verifiedJson(
      `/v2/${repository}/blobs/${configDigest}`,
      configDigest,
      "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json",
      "config",
    )).value;
    const labels = config.config?.Labels ?? {};
    if (config.os !== "linux"
      || config.architecture !== "amd64"
      || labels["org.opencontainers.image.source"] !== "https://github.com/mkaand/changd-fusion"
      || labels["org.opencontainers.image.revision"] !== expected.source_sha
      || labels["org.opencontainers.image.version"] !== expected.version) {
      throw Error("oci_metadata_mismatch");
    }
    return {
      reference,
      digest: requestedDigest,
      manifestDigest,
      configDigest,
      revision: expected.source_sha,
      version: expected.version,
      platform: "linux/amd64",
    };
  }

  async verifyReleaseImages(manifest) {
    if (manifest.api_worker_shared_image !== manifest.api_image) {
      throw Error("api_worker_image_mismatch");
    }
    return {
      api: await this.verifyImage(manifest.api_image, manifest),
      ui: await this.verifyImage(manifest.ui_image, manifest),
    };
  }
}

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, required) {
  const left = versionTuple(actual);
  const right = versionTuple(required);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function spawnVerifier(spawn, ghPath, args, token) {
  const result = spawn(ghPath, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2_000_000,
    env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
  });
  if (result?.error || result?.status !== 0) throw Error("attestation_verifier_failed");
  return result;
}

export function verifyAttestationWithGh({
  subject,
  expected,
  token,
  ghPath = "gh",
  spawn = spawnSync,
  bundle,
  customTrustedRoot,
} = {}) {
  if (typeof subject !== "string" || (!subject.startsWith("oci://") && !subject.startsWith("/"))) {
    throw Error("invalid_attestation_subject");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected?.repository ?? "")
    || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(expected?.workflow ?? "")
    || !/^[0-9a-f]{40}$/.test(expected?.sourceSha ?? "")
    || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(expected?.sourceRef ?? "")
    || !["sha256", "sha512"].includes(expected?.digestAlgorithm)
    || !new RegExp(`^[0-9a-f]{${expected?.digestAlgorithm === "sha512" ? 128 : 64}}$`).test(expected?.subjectDigest ?? "")) {
    throw Error("invalid_attestation_policy");
  }

  const versionResult = spawnVerifier(spawn, ghPath, ["--version"], token);
  const actualVersion = /^gh version (\d+\.\d+\.\d+)/m.exec(versionResult.stdout)?.[1];
  if (!actualVersion || !versionAtLeast(actualVersion, SUPPORTED_GH_ATTESTATION_VERSION)) {
    throw Error("unsupported_gh_attestation_version");
  }

  const signerWorkflow = `${expected.repository}/${expected.workflow}`;
  const args = [
    "attestation",
    "verify",
    subject,
    "--repo",
    expected.repository,
    "--signer-workflow",
    signerWorkflow,
    "--source-digest",
    expected.sourceSha,
    "--source-ref",
    expected.sourceRef,
    "--cert-oidc-issuer",
    GITHUB_OIDC_ISSUER,
    "--deny-self-hosted-runners",
    "--predicate-type",
    SLSA_PROVENANCE_V1,
    "--digest-alg",
    expected.digestAlgorithm,
    "--format",
    "json",
  ];
  if (bundle) args.push("--bundle", bundle);
  if (customTrustedRoot) args.push("--custom-trusted-root", customTrustedRoot);
  const run = spawnVerifier(spawn, ghPath, args, token);

  let output;
  try {
    output = JSON.parse(run.stdout);
  } catch {
    throw Error("invalid_attestation_output");
  }
  if (!Array.isArray(output) || output.length !== 1) throw Error("ambiguous_attestation");
  const verification = output[0]?.verificationResult;
  const certificate = verification?.signature?.certificate;
  const timestamps = verification?.verifiedTimestamps;
  const statement = verification?.statement;
  if (!certificate || !Array.isArray(timestamps) || timestamps.length === 0 || !statement) {
    throw Error("incomplete_verified_attestation");
  }

  const repositoryUrl = `https://github.com/${expected.repository}`;
  const signerUri = `${repositoryUrl}/${expected.workflow}@${expected.sourceRef}`;
  const certificateMatches = certificate.issuer === GITHUB_OIDC_ISSUER
    && certificate.githubWorkflowRepository === expected.repository
    && certificate.githubWorkflowRef === expected.sourceRef
    && certificate.buildSignerURI === signerUri
    && certificate.runnerEnvironment === "github-hosted"
    && certificate.sourceRepositoryURI === repositoryUrl
    && certificate.sourceRepositoryDigest === expected.sourceSha
    && certificate.sourceRepositoryRef === expected.sourceRef
    && certificate.buildConfigURI === signerUri;
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies ?? [];
  const builder = statement.predicate?.runDetails?.builder?.id;
  const subjectMatches = statement.subject?.some(
    (item) => item?.digest?.[expected.digestAlgorithm] === expected.subjectDigest,
  );
  const claimsMatch = statement.predicateType === SLSA_PROVENANCE_V1
    && subjectMatches
    && workflow.repository === repositoryUrl
    && workflow.path === expected.workflow
    && workflow.ref === expected.sourceRef
    && builder === "https://github.com/actions/runner/github-hosted"
    && dependencies.some((item) => item?.digest?.gitCommit === expected.sourceSha);
  if (!certificateMatches || !claimsMatch) throw Error("attestation_claim_mismatch");
  return { certificate, statement, verifiedTimestamps: timestamps };
}

export function createGhAttestationVerifier({ token, ghPath = "gh", spawn = spawnSync } = {}) {
  return async (manifest, context) => {
    const subjects = [["api", manifest.api_image], ["ui", manifest.ui_image]];
    for (const [name, reference] of subjects) {
      const inspected = context.images?.[name];
      if (inspected?.reference !== reference
        || inspected?.revision !== manifest.source_sha
        || inspected?.version !== manifest.version) {
        throw Error(`unverified_oci_subject_${name}`);
      }
      verifyAttestationWithGh({
        subject: `oci://${reference}`,
        token,
        ghPath,
        spawn,
        expected: {
          repository: context.repository,
          workflow: context.workflow,
          sourceSha: manifest.source_sha,
          sourceRef: "refs/heads/master",
          digestAlgorithm: "sha256",
          subjectDigest: reference.split("@sha256:")[1],
        },
      });
    }
    return { attested: true, revision: manifest.source_sha, version: manifest.version };
  };
}
