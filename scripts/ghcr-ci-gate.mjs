import { readFile } from "node:fs/promises";

export const REQUIRED_JOBS = ["verify", "privacy", "docker", "docker-arm64"];

function newestFirst(runs) {
  return [...runs].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) ||
    Number(b.run_number ?? 0) - Number(a.run_number ?? 0) ||
    Number(b.run_attempt ?? 0) - Number(a.run_attempt ?? 0)
  );
}

export function selectCiRun(runsDocument, sourceSha) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("source SHA must be a complete lowercase commit SHA");
  const runs = runsDocument?.workflow_runs;
  if (!Array.isArray(runs) || runsDocument.total_count !== runs.length) {
    throw new Error("CI workflow evidence is incomplete or paginated");
  }
  const candidates = newestFirst(runs.filter(run =>
    run.name === "CI" && run.head_sha === sourceSha && run.path === ".github/workflows/ci.yml"
  ));
  if (candidates.length === 0) throw new Error("no trusted CI workflow run exists for the exact source SHA");
  const run = candidates[0];
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`latest trusted CI workflow run is not successful: ${run.status}/${run.conclusion}`);
  }
  return run;
}

export function verifyCiGate(runsDocument, jobsDocument, sourceSha) {
  const run = selectCiRun(runsDocument, sourceSha);
  const jobs = jobsDocument?.jobs;
  if (!Array.isArray(jobs) || jobsDocument.total_count !== jobs.length) {
    throw new Error("CI job evidence is incomplete or paginated");
  }
  const failures = REQUIRED_JOBS.filter(name => !jobs.some(job =>
    job.name === name &&
    job.status === "completed" &&
    job.conclusion === "success" &&
    Number(job.run_attempt) === Number(run.run_attempt)
  ));
  if (failures.length) throw new Error(`latest trusted CI run lacks successful required jobs: ${failures.join(", ")}`);
  return run;
}

async function main() {
  const [command, runsPath, jobsPath, sourceSha] = process.argv.slice(2);
  const runs = JSON.parse(await readFile(runsPath, "utf8"));
  if (command === "select") {
    process.stdout.write(`${selectCiRun(runs, sourceSha).id}\n`);
    return;
  }
  if (command === "verify") {
    const jobs = JSON.parse(await readFile(jobsPath, "utf8"));
    const run = verifyCiGate(runs, jobs, sourceSha);
    process.stdout.write(`CI gate accepted workflow run ${run.id} attempt ${run.run_attempt}\n`);
    return;
  }
  throw new Error("usage: ghcr-ci-gate.mjs select <runs.json> - <source-sha> | verify <runs.json> <jobs.json> <source-sha>");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exitCode = 1; });
