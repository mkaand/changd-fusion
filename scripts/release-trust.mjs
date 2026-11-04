import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const IMAGE_REFERENCE = /^ghcr\.io\/mkaand\/changd-fusion-(api|ui)@sha256:([0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_REGISTRY_RESPONSE = 2_000_000;
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json";

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

  async bytes(path, accept) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(new URL(path, this.baseUrl), {
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept,
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
      });
      if (!response.ok) throw Error(`registry_http_${response.status}`);
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

export function createGhAttestationVerifier({ token, spawn = spawnSync } = {}) {
  return async (manifest, context) => {
    const subjects = [["api", manifest.api_image], ["ui", manifest.ui_image]];
    for (const [name, reference] of subjects) {
      const inspected = context.images?.[name];
      if (inspected?.reference !== reference
        || inspected?.revision !== manifest.source_sha
        || inspected?.version !== manifest.version) {
        throw Error(`unverified_oci_subject_${name}`);
      }
      const run = spawn("gh", [
        "attestation",
        "verify",
        `oci://${reference}`,
        "--repo",
        context.repository,
        "--signer-workflow",
        context.workflow,
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 2_000_000,
        env: { ...process.env, ...(token ? { GH_TOKEN: token } : {}) },
      });
      if (run.status !== 0) throw Error(`attestation_verify_failed_${name}`);
      let output;
      try {
        output = JSON.parse(run.stdout);
      } catch {
        throw Error("invalid_attestation_output");
      }
      const results = Array.isArray(output) ? output : [output];
      const statements = results.map((item) => item?.verificationResult?.statement).filter(Boolean);
      if (statements.length !== 1) throw Error("ambiguous_attestation");
      const statement = statements[0];
      const wantedDigest = reference.split("@sha256:")[1];
      const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
      const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies ?? [];
      const builder = statement.predicate?.runDetails?.builder?.id;
      const subjectMatches = statement.subject?.some((item) => item?.digest?.sha256 === wantedDigest);
      const sourceMatches = dependencies.some(
        (item) => item?.digest?.gitCommit === manifest.source_sha,
      );
      if (!subjectMatches
        || workflow.repository !== `https://github.com/${context.repository}`
        || workflow.path !== context.workflow
        || workflow.ref !== "refs/heads/master"
        || builder !== "https://github.com/actions/runner/github-hosted"
        || !sourceMatches) {
        throw Error("attestation_claim_mismatch");
      }
    }
    return { attested: true, revision: manifest.source_sha, version: manifest.version };
  };
}
