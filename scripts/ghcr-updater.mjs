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
  const candidates = runs.filter((r) => r.name === "GHCR immutable release"
    && r.path === ".github/workflows/ghcr-release.yml"
    && r.status === "completed"
    && r.conclusion === "success"
    && r.head_branch === "master"
    && Number.isInteger(r.run_attempt)
    && r.run_attempt >= 1
    && r.repository === trusted.repository);
  if (candidates.length > 1) throw Error("ambiguous_release_runs");
  if (!candidates.length) return null;
  const run = candidates[0], manifest = await client.manifest(run, { timeoutMs: 10_000 });
  return { workflow: run, manifest, ci: await client.ci(run.head_sha, { timeoutMs: 10_000 }), masterLineage: await client.masterLineage(run.head_sha), publisher: await client.attestation(manifest) };
}
export function migrationGate(current, candidate) {
  if (!candidate?.migrationCompatibility || candidate.migrationCompatibility !== "forward-safe") return { ok:false, reason:"unsafe_migration" };
  if (current?.migrationVersion && candidate.migrationVersion < current.migrationVersion) return { ok:false, reason:"migration_downgrade" };
  return { ok:true };
}
export async function withUpdaterLock(lock, fn) { if (!(await lock.acquire())) return { updated:false, reason:"concurrent_updater" }; try { return await fn(); } finally { await lock.release(); } }
export async function runUpdater({ evidence, state, config, docker, lock, notify, drainAuthorization, maintenance }) {
  if (lock) return withUpdaterLock(lock, () => runUpdater({ evidence, state, config, docker, notify, drainAuthorization, maintenance }));
  const checked=verifyRelease(evidence,state); if (!checked.ok) return { updated:false, ...checked };
  const plan=deploymentPlan(checked.release,config);
  if (!(await docker.projectIsExpected(plan.project, plan.services, checked.release))) { await notify?.("critical", "unsafe_project"); return { updated:false, reason:"unsafe_project" }; }
  const migration=migrationGate(state, checked.release); if (!migration.ok) { await notify?.("critical", migration.reason); return { updated:false, ...migration }; }
  if (plan.dryRun) return { updated:false, dryRun:true, plan };
  let authorization = drainAuthorization;
  try {
    authorization ??= await maintenance?.drain({ project: plan.project, sourceSha: checked.release.source_sha });
  } catch {
    await notify?.("critical", "drain_failed");
    return { updated:false, reason:"drain_failed" };
  }
  if (!(await docker.safeDrain(plan.project, checked.release.source_sha, authorization))) {
    await maintenance?.fail(authorization, "unsafe_drain");
    await notify?.("critical", "unsafe_drain");
    return { updated:false, reason:"unsafe_drain" };
  }
  try {
    await docker.compose(plan.project, ["pull", ...plan.services], checked.release.source_sha, checked.release);
    await docker.compose(plan.project, ["up", "-d", "--no-deps", "--no-build", ...plan.services], checked.release.source_sha, checked.release);
    if (!(await docker.healthy(plan))) {
      await maintenance?.fail(authorization, "healthcheck_failed");
      await notify?.("critical", "healthcheck_failed");
      return { updated:false, reason:"healthcheck_failed" };
    }
    await docker.writeStateAtomically({ source_sha:checked.release.source_sha, version:checked.release.version, api_image:checked.release.api_image, ui_image:checked.release.ui_image });
    if (maintenance && !(await maintenance.resume(authorization))) {
      await maintenance.fail(authorization, "maintenance_resume_failed");
      await notify?.("critical", "maintenance_resume_failed");
      return { updated:false, reason:"maintenance_resume_failed" };
    }
    docker.completeDrain?.();
    await notify?.("success", `updated:${checked.release.version}`);
    return { updated:true, plan };
  } catch {
    await maintenance?.fail(authorization, "deployment_failed");
    await notify?.("critical", "deployment_failed");
    return { updated:false, reason:"deployment_failed" };
  }
}
