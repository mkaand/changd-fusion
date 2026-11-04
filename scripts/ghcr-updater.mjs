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
export async function discoverRelease(client, trusted) {
  const runs = await client.runs({ workflow: "ghcr-release.yml", repository: trusted.repository, timeoutMs: 10_000 });
  if (!Array.isArray(runs) || runs.some((r) => r.nextPage)) throw Error("ambiguous_release_listing");
  const candidates = runs.filter((r) => r.name === "GHCR immutable release" && r.conclusion === "success" && r.repository === trusted.repository);
  if (candidates.length > 1) throw Error("ambiguous_release_runs");
  if (!candidates.length) return null;
  const run = candidates[0], manifest = await client.manifest(run.id, { timeoutMs: 10_000 });
  return { workflow: run, manifest, ci: await client.ci(run.head_sha, { timeoutMs: 10_000 }), masterLineage: await client.masterLineage(run.head_sha), publisher: await client.attestation(manifest) };
}
export function migrationGate(current, candidate) {
  if (!candidate?.migrationCompatibility || candidate.migrationCompatibility !== "forward-safe") return { ok:false, reason:"unsafe_migration" };
  if (current?.migrationVersion && candidate.migrationVersion < current.migrationVersion) return { ok:false, reason:"migration_downgrade" };
  return { ok:true };
}
export async function withUpdaterLock(lock, fn) { if (!(await lock.acquire())) return { updated:false, reason:"concurrent_updater" }; try { return await fn(); } finally { await lock.release(); } }
export async function runUpdater({ evidence, state, config, docker, lock, notify }) {
  if (lock) return withUpdaterLock(lock, () => runUpdater({ evidence, state, config, docker, notify }));
  const checked=verifyRelease(evidence,state); if (!checked.ok) return { updated:false, ...checked };
  const plan=deploymentPlan(checked.release,config);
  if (plan.dryRun) return { updated:false, dryRun:true, plan };
  // The host wrapper must first prove its project membership and safe drain;
  // absence of either proof deliberately aborts before Compose mutation.
  if (!(await docker.safeDrain(plan.project)) || !(await docker.projectIsExpected(plan.project, plan.services))) { await notify?.("critical", "unsafe_drain"); return { updated:false, reason:"unsafe_drain" }; }
  const migration=migrationGate(state, checked.release); if (!migration.ok) { await notify?.("critical", migration.reason); return { updated:false, ...migration }; }
  await docker.compose(plan.project, ["pull", ...plan.services]);
  await docker.compose(plan.project, ["up", "-d", "--no-deps", ...plan.services]);
  if (!(await docker.healthy(plan))) { await notify?.("critical", "healthcheck_failed"); return { updated:false, reason:"healthcheck_failed" }; }
  await docker.writeStateAtomically({ source_sha:checked.release.source_sha, version:checked.release.version, api_image:checked.release.api_image, ui_image:checked.release.ui_image });
  await notify?.("success", `updated:${checked.release.version}`);
  return { updated:true, plan };
}
