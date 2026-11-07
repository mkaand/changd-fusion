#!/usr/bin/env node
import { randomUUID } from "node:crypto";
// Opt-in host updater. Discovery is intentionally externalized: an operator
// supplies authenticated GitHub/GHCR evidence; this module never trusts a
// self-declared manifest or mutates Docker without an approved plan.
const sha = /^[0-9a-f]{40}$/;
const digest = /^ghcr\.io\/mkaand\/changd-fusion-(?:api|ui)@sha256:[0-9a-f]{64}$/;
function compareVersions(left, right) {
  const parse = (value) => /^\d+\.\d+\.\d+$/.test(value ?? "") ? value.split(".").map(Number) : null;
  const a = parse(left), b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
function sameRelease(left, right) {
  return Boolean(left && right && ["version", "source_sha", "api_image", "ui_image"].every((key) => left[key] === right[key]));
}
export function verifyRelease(evidence, state) {
  const m = evidence?.manifest;
  if (!m || !sha.test(m.source_sha ?? "") || !digest.test(m.api_image ?? "") || !digest.test(m.ui_image ?? "") || compareVersions(m.version, m.version) !== 0) return { ok:false, reason:"invalid_manifest" };
  if (m.architecture !== "linux/amd64" || m.api_worker_shared_image !== m.api_image) return { ok:false, reason:"image_contract" };
  if (evidence.workflow?.name !== "GHCR immutable release" || evidence.workflow?.conclusion !== "success" || evidence.workflow?.head_sha !== m.source_sha) return { ok:false, reason:"release_workflow" };
  if (!evidence.masterLineage || !["verify","privacy","docker","docker-arm64"].every((job) => evidence.ci?.[job] === "success")) return { ok:false, reason:"ci_evidence" };
  if (!evidence.publisher?.attested || evidence.publisher.revision !== m.source_sha || evidence.publisher.version !== m.version) return { ok:false, reason:"publisher_provenance" };
  if (state?.source_sha === m.source_sha) return { ok:false, reason:"replay" };
  if (state?.version) {
    const order = compareVersions(m.version, state.version);
    if (order === null) return { ok:false, reason:"invalid_state_version" };
    if (order === -1) return { ok:false, reason:"downgrade" };
    if (order === 0) {
      // Identical semver is permitted for a newer master commit only after
      // GitHub proves the installed source is an ancestor of the candidate.
      // Exact binding to the persisted source prevents stale/replayed proofs.
      const ancestry = evidence.installedAncestry;
      if (!ancestry || ancestry.from !== state.source_sha || ancestry.to !== m.source_sha
        || ancestry.verified !== true) return { ok:false, reason:"same_version_conflict" };
    }
  }
  return { ok:true, release:m };
}
export function deploymentPlan(release, config) {
  if (!config?.project || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.project)) throw Error("invalid_project");
  return { project:config.project, services:["api","worker","ui"], images:{ api:release.api_image, ui:release.ui_image }, dryRun:Boolean(config.dryRun) };
}
export async function discoverRelease(client, trusted) {
  if (trusted.installedSourceSha !== undefined && !sha.test(trusted.installedSourceSha)) throw Error("invalid_installed_source");
  trusted.onStage?.("release_listing");
  const runs = await client.runs({ workflow: "ghcr-release.yml", repository: trusted.repository, timeoutMs: 10_000 });
  if (!Array.isArray(runs) || runs.some((r) => r.nextPage)) throw Error("ambiguous_release_listing");
  const candidates = runs.filter((r) => r.name === "GHCR immutable release"
    && r.path === ".github/workflows/ghcr-release.yml"
    && r.status === "completed"
    && r.conclusion === "success"
    && r.head_branch === "master"
    && Number.isSafeInteger(r.id)
    && r.id > 0
    && Number.isInteger(r.run_attempt)
    && r.run_attempt >= 1
    && sha.test(r.head_sha ?? "")
    && r.repository === trusted.repository
    && (trusted.installedSourceSha === undefined || r.head_sha === trusted.installedSourceSha));
  if (!candidates.length) return null;
  // Elect the newest successful trusted publisher run before checking CI.
  // Historical releases remain immutable evidence, but a later cancelled
  // CI rerun on an old SHA must not invalidate the current signed release.
  // Never fall back to an older release if this elected candidate fails.
  if (new Set(candidates.map((run) => run.id)).size !== candidates.length) {
    throw Error("ambiguous_release_listing");
  }
  const ordered = [...candidates].sort((a, b) => b.id - a.id);
  const run = ordered[0];
  trusted.onStage?.("release_manifest");
  const manifest = await client.manifest(run, { timeoutMs: 10_000 });
  trusted.onStage?.("release_ci");
  const ci = await client.ci(run.head_sha, { timeoutMs: 10_000 });
  trusted.onStage?.("release_lineage");
  const masterLineage = await client.masterLineage(run.head_sha);
  trusted.onStage?.("release_attestation");
  const publisher = await client.attestation(manifest);
  const evidence = { workflow: run, manifest, ci, masterLineage, publisher };
  trusted.onStage?.("release_trust");
  const check = verifyRelease(evidence, {});
  if (!check.ok) throw Error(`untrusted_release_candidate_${check.reason}`);

  // Preserve ancestry and same-SHA ambiguity checks without revalidating
  // superseded CI runs (whose later cancellation is unrelated to the chosen
  // release's provenance). All older publisher SHAs must be ancestors of the
  // elected SHA; an out-of-order publication must fail closed, not downgrade.
  for (const older of ordered.slice(1)) {
    if (older.head_sha === run.head_sha) {
      trusted.onStage?.("historical_manifest");
      const previous = await client.manifest(older, { timeoutMs: 10_000 });
      if (!sameRelease(previous, manifest)) throw Error("ambiguous_release_source");
    } else {
      trusted.onStage?.("historical_lineage");
      if (!await client.sourceLineage(older.head_sha, run.head_sha)) throw Error("incompatible_release_ancestry");
    }
  }
  return evidence;
}
export function migrationGate(current, candidate) {
  if (current?.bootstrapped === false) return { ok:false, reason:"BOOTSTRAP_REQUIRED" };
  if (Array.isArray(current?.migrations) || Array.isArray(candidate?.migrations)) {
    if (!Array.isArray(current?.migrations) || !Array.isArray(candidate?.migrations)
      || JSON.stringify(current.migrations) !== JSON.stringify(candidate.migrations)) return { ok:false, reason:"unsafe_migration" };
    return { ok:true };
  }
  if (!candidate?.migrationCompatibility || candidate.migrationCompatibility !== "forward-safe") return { ok:false, reason:"unsafe_migration" };
  if (current?.migrationVersion && candidate.migrationVersion < current.migrationVersion) return { ok:false, reason:"migration_downgrade" };
  return { ok:true };
}
export async function withUpdaterLock(lock, fn) { if (!(await lock.acquire())) return { updated:false, reason:"concurrent_updater" }; try { return await fn(); } finally { await lock.release(); } }
export async function runUpdater({ evidence, state, config, docker, lock, notify, drainAuthorization, maintenance, stateStore, telegram }) {
  if (lock) return withUpdaterLock(lock, () => runUpdater({ evidence, state, config, docker, notify, drainAuthorization, maintenance, stateStore, telegram }));
  let checked=verifyRelease(evidence,stateStore ? {} : state); if (!checked.ok) return { updated:false, ...checked };
  const plan=deploymentPlan(checked.release,config);
  if (!(await docker.projectIsExpected(plan.project, plan.services, checked.release))) { await notify?.("critical", "unsafe_project"); return { updated:false, reason:"unsafe_project" }; }
  let persisted;
  let baseline;
  let operationId;
  const recordFailure = (status, code, stage) => {
    if (!stateStore || !persisted) return false;
    try {
      persisted = stateStore.transition(persisted, status, { failure: { code, stage } });
      return true;
    } catch { return false; }
  };
  const sendFailure = async (status, code, stage) => {
    if (!telegram) return;
    const recoveryOperation = operationId ?? persisted?.operation_id;
    if (status === "RECOVERY_REQUIRED" && recoveryOperation
      && persisted?.notification?.recovery_operation === recoveryOperation) return;
    if (status === "RECOVERY_REQUIRED" && recoveryOperation && stateStore && persisted) {
      try { persisted = stateStore.markRecoveryNotification(persisted, recoveryOperation); } catch {}
    }
    let result;
    try {
      result = await telegram.send(status === "RECOVERY_REQUIRED" ? "recovery_required" : "critical", status === "RECOVERY_REQUIRED"
        ? { operation_id: operationId ?? persisted?.operation_id ?? "none", state: code }
        : { stage, category: code, safe_stop: "retained" });
    } catch { result = { error: "telegram_delivery_failed" }; }
    if (result?.error && stateStore && persisted) {
      try { persisted = stateStore.recordNotificationFailure(persisted, result.error); } catch {}
    }
  };
  if (stateStore) {
    try {
      persisted = stateStore.reconcile(stateStore.load());
      if (persisted.status === "RECOVERY_REQUIRED") return { updated:false, reason:"recovery_required" };
      const bootstrap = await maintenance?.bootstrapStatus(plan.project);
      if (!bootstrap?.bootstrapped) {
        recordFailure("FAILED", "BOOTSTRAP_REQUIRED", "bootstrap");
        await sendFailure("RECOVERY_REQUIRED", "BOOTSTRAP_REQUIRED", "bootstrap");
        return { updated:false, reason:"BOOTSTRAP_REQUIRED" };
      }
      const runtime = docker.runtimeIdentity();
      if (persisted.current && !sameRelease(persisted.current, runtime)) {
        recordFailure("RECOVERY_REQUIRED", "runtime_state_mismatch", "reconcile");
        return { updated:false, reason:"recovery_required" };
      }
      if (!persisted.current) persisted = { ...persisted, current: runtime };
      checked = verifyRelease(evidence, persisted.current); if (!checked.ok) return { updated:false, ...checked };
      baseline = await docker.captureBaseline();
      const migration=migrationGate({ ...persisted.current, migrations: baseline.migrations, bootstrapped: true }, checked.release);
      if (!migration.ok) { recordFailure("FAILED", migration.reason, "migration"); return { updated:false, ...migration }; }
    } catch {
      recordFailure("RECOVERY_REQUIRED", "state_or_reconcile_failed", "preparing");
      return { updated:false, reason:"recovery_required" };
    }
  } else {
    const migration=migrationGate(state, checked.release); if (!migration.ok) { await notify?.("critical", migration.reason); return { updated:false, ...migration }; }
  }
  if (plan.dryRun) return { updated:false, dryRun:true, plan };
  if (stateStore) {
    operationId = randomUUID();
    persisted = stateStore.transition(persisted, "PREPARING", { operation_id: operationId, candidate: {
      version: checked.release.version, source_sha: checked.release.source_sha,
      api_image: checked.release.api_image, ui_image: checked.release.ui_image,
    }, failure: null });
  }
  let authorization = drainAuthorization;
  try {
    if (stateStore) persisted = stateStore.transition(persisted, "DRAINING");
    authorization ??= await maintenance?.drain({ project: plan.project, sourceSha: checked.release.source_sha, operationId });
  } catch {
    recordFailure("FAILED", "drain_failed", "draining");
    await sendFailure("FAILED", "drain_failed", "draining");
    await notify?.("critical", "drain_failed");
    return { updated:false, reason:"drain_failed" };
  }
  if (operationId && authorization?.operation_id !== operationId) {
    recordFailure("RECOVERY_REQUIRED", "drain_identity_mismatch", "draining");
    await maintenance?.fail(authorization, "drain_identity_mismatch");
    await sendFailure("RECOVERY_REQUIRED", "drain_identity_mismatch", "draining");
    return { updated:false, reason:"unsafe_drain" };
  }
  if (!(await docker.safeDrain(plan.project, checked.release.source_sha, authorization))) {
    recordFailure("RECOVERY_REQUIRED", "unsafe_drain", "draining");
    await maintenance?.fail(authorization, "unsafe_drain");
    await sendFailure("RECOVERY_REQUIRED", "unsafe_drain", "draining");
    await notify?.("critical", "unsafe_drain");
    return { updated:false, reason:"unsafe_drain" };
  }
  try {
    if (stateStore) {
      const quiescentBaseline = await docker.captureBaseline();
      const migration = migrationGate({ migrations: quiescentBaseline.migrations, bootstrapped: true }, checked.release);
      if (!migration.ok) {
        recordFailure("RECOVERY_REQUIRED", migration.reason, "migration");
        await maintenance?.fail(authorization, migration.reason);
        await sendFailure("RECOVERY_REQUIRED", migration.reason, "migration");
        return { updated:false, ...migration };
      }
      baseline = quiescentBaseline;
    }
    if (stateStore) persisted = stateStore.transition(persisted, "DEPLOYING");
    await docker.compose(plan.project, ["pull", ...plan.services], checked.release.source_sha, checked.release);
    await docker.compose(plan.project, ["up", "-d", "--no-deps", "--no-build", ...plan.services], checked.release.source_sha, checked.release);
    if (stateStore) persisted = stateStore.transition(persisted, "VERIFYING");
    const health = stateStore ? await docker.verifyDeploymentHealth(plan, baseline) : await docker.healthy(plan);
    if (!health) {
      recordFailure("RECOVERY_REQUIRED", "healthcheck_failed", "verifying");
      await maintenance?.fail(authorization, "healthcheck_failed");
      await sendFailure("RECOVERY_REQUIRED", "healthcheck_failed", "verifying");
      await notify?.("critical", "healthcheck_failed");
      return { updated:false, reason:"healthcheck_failed" };
    }
    if (stateStore) persisted = stateStore.transition(persisted, "SUCCESS", {
      previous: persisted.current, current: persisted.candidate, candidate: null, failure: null, maintenance_released: false,
    });
    else await docker.writeStateAtomically({ source_sha:checked.release.source_sha, version:checked.release.version, api_image:checked.release.api_image, ui_image:checked.release.ui_image });
    if (maintenance && !(await maintenance.resume(authorization))) {
      recordFailure("RECOVERY_REQUIRED", "maintenance_resume_failed", "resume");
      await maintenance.fail(authorization, "maintenance_resume_failed");
      await sendFailure("RECOVERY_REQUIRED", "maintenance_resume_failed", "resume");
      await notify?.("critical", "maintenance_resume_failed");
      return { updated:false, reason:"maintenance_resume_failed" };
    }
    docker.completeDrain?.();
    if (stateStore) persisted = stateStore.write({ ...persisted, maintenance_released: true });
    if (stateStore && telegram && persisted.notification?.success_operation !== operationId) {
      // Persist the at-most-once notification identity before crossing the
      // remote Bot API boundary. A host crash may lose an alert, but cannot
      // send duplicate success alerts for one deployment operation.
      persisted = stateStore.markNotification(persisted, operationId, null);
      let delivered;
      try {
        delivered = await telegram.send("success", { version: checked.release.version, source_sha: checked.release.source_sha,
          operation_id: operationId, health: "verified", timestamp: new Date().toISOString() });
      } catch { delivered = { error: "telegram_delivery_failed" }; }
      if (delivered.error) {
        try { persisted = stateStore.recordNotificationFailure(persisted, delivered.error); } catch {}
      }
    }
    await notify?.("success", `updated:${checked.release.version}`);
    return { updated:true, plan };
  } catch {
    recordFailure("RECOVERY_REQUIRED", "deployment_failed", "deploying");
    await maintenance?.fail(authorization, "deployment_failed");
    await sendFailure("RECOVERY_REQUIRED", "deployment_failed", "deploying");
    await notify?.("critical", "deployment_failed");
    return { updated:false, reason:"deployment_failed" };
  }
}
