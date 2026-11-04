#!/usr/bin/env node
// Opt-in host updater. Discovery is intentionally externalized: an operator
// supplies authenticated GitHub/GHCR evidence; this module never trusts a
// self-declared manifest or mutates Docker without an approved plan.
const sha = /^[0-9a-f]{40}$/;
const digest = /^ghcr\.io\/mkaand\/changd-fusion-(?:api|ui)@sha256:[0-9a-f]{64}$/;
export function verifyRelease(evidence, state) {
  const m = evidence?.manifest;
  if (!m || !sha.test(m.source_sha ?? "") || !digest.test(m.api_image ?? "") || !digest.test(m.ui_image ?? "")) return { ok:false, reason:"invalid_manifest" };
  if (m.architecture !== "linux/amd64" || m.api_worker_shared_image !== m.api_image) return { ok:false, reason:"image_contract" };
  if (evidence.workflow?.name !== "GHCR immutable release" || evidence.workflow?.conclusion !== "success" || evidence.workflow?.head_sha !== m.source_sha) return { ok:false, reason:"release_workflow" };
  if (!evidence.masterLineage || !["verify","privacy","docker","docker-arm64"].every((job) => evidence.ci?.[job] === "success")) return { ok:false, reason:"ci_evidence" };
  if (!evidence.publisher?.attested || evidence.publisher.revision !== m.source_sha || evidence.publisher.version !== m.version) return { ok:false, reason:"publisher_provenance" };
  if (state?.source_sha === m.source_sha) return { ok:false, reason:"replay" };
  if (state?.version && m.version < state.version) return { ok:false, reason:"downgrade" };
  return { ok:true, release:m };
}
export function deploymentPlan(release, config) {
  if (!config?.project || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.project)) throw Error("invalid_project");
  return { project:config.project, services:["api","worker","ui"], images:{ api:release.api_image, ui:release.ui_image }, dryRun:Boolean(config.dryRun) };
}
export async function runUpdater({ evidence, state, config, docker }) {
  const checked=verifyRelease(evidence,state); if (!checked.ok) return { updated:false, ...checked };
  const plan=deploymentPlan(checked.release,config);
  if (plan.dryRun) return { updated:false, dryRun:true, plan };
  // The host wrapper must first prove its project membership and safe drain;
  // absence of either proof deliberately aborts before Compose mutation.
  if (!(await docker.safeDrain(plan.project)) || !(await docker.projectIsExpected(plan.project, plan.services))) return { updated:false, reason:"unsafe_drain" };
  await docker.compose(plan.project, ["pull", ...plan.services]);
  await docker.compose(plan.project, ["up", "-d", "--no-deps", ...plan.services]);
  if (!(await docker.healthy(plan))) return { updated:false, reason:"healthcheck_failed" };
  await docker.writeStateAtomically({ source_sha:checked.release.source_sha, version:checked.release.version, api_image:checked.release.api_image, ui_image:checked.release.ui_image });
  return { updated:true, plan };
}
