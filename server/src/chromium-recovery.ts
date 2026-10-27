import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makePool, transaction, type Pool } from "./db.js";

const execute = promisify(execFile);
const namespace = 0x43484645;
export type ContainerFence = {
  daemonId: string;
  project: string;
  containerIds: string[];
};
type DockerRead = (args: string[]) => Promise<string>;

// This is an OFFLINE operator tool, never an API or automatic startup action.
// Docker evidence is valid only after the operator has fenced all replicas and
// paused every restart/deployment mechanism on the single declared Docker host.
export async function verifyStoppedContainers(fence: ContainerFence, read: DockerRead = dockerRead) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(fence.project) ||
      !fence.daemonId || !fence.containerIds.length || fence.containerIds.length > 32 ||
      fence.containerIds.some(id => !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(fence.containerIds).size !== fence.containerIds.length)
    throw Error("Invalid fencing scope; use exact Docker IDs and a single Compose project.");
  if ((await read(["info", "--format", "{{.ID}}"])).trim() !== fence.daemonId)
    throw Error("Docker daemon identity mismatch; quarantine retained.");
  const listed = (await read(["ps", "--all", "--no-trunc", "--quiet", "--filter", `label=com.docker.compose.project=${fence.project}`])).trim().split(/\s+/).filter(Boolean);
  if (!listed.length) throw Error("No containers found for fencing scope; quarantine retained.");
  // Inspect only lifecycle fields and labels: never environment, command lines,
  // mounts, page data, selectors or credentials.
  const lines = (await read(["inspect", "--format", '[{{json .Id}},{{json .State}},{{json .HostConfig.RestartPolicy.Name}},{{json .Config.Labels}},{{json .HostConfig.PidMode}},{{json .HostConfig.Privileged}}]', ...listed])).trim().split("\n");
  const runtimes: string[] = [];
  for (const line of lines) {
    const evidence = JSON.parse(line);
    if (!Array.isArray(evidence) || evidence.length !== 6)
      throw Error("Unrecognized Docker lifecycle evidence; quarantine retained.");
    const [id, state, restart, labels, pidMode, privileged] = evidence;
    if (labels?.["com.docker.compose.project"] !== fence.project)
      throw Error("Docker project changed during verification; quarantine retained.");
    const service = labels?.["com.docker.compose.service"];
    if (!["api", "worker", "migrate", "db", "ui"].includes(service))
      throw Error("Unknown service in fencing scope; quarantine retained.");
    if (["db", "ui"].includes(service)) continue;
    runtimes.push(id);
    if (privileged !== false || !["", "private"].includes(pidMode))
      throw Error("Privileged or shared-PID containers are outside supported fencing scope.");
    if (state.Running || state.Paused || state.Restarting || state.Dead || state.Pid !== 0 ||
        state.Status !== "exited" || !state.FinishedAt || state.FinishedAt.startsWith("0001-") || restart !== "no")
      throw Error("Runtime container is not conclusively stopped with restart disabled; quarantine retained.");
  }
  if (JSON.stringify(runtimes.sort()) !== JSON.stringify([...fence.containerIds].sort()))
    throw Error("Runtime replica inventory mismatch; quarantine retained.");
}

async function dockerRead(args: string[]) {
  const env = { ...process.env };
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
  const result = await execute("docker", ["--host=unix:///var/run/docker.sock", ...args], { env, timeout: 5000, maxBuffer: 256 * 1024 });
  return result.stdout;
}

export async function recoverChromiumQuarantine(pool: Pool, expectedToken: string, verifyFence: () => Promise<void>) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(expectedToken))
    throw Error("An exact expected quarantine token is required.");
  await transaction(pool, async client => {
    // Block both supported and legacy admission protocols while recovering.
    // A live owner/legacy lease, changed token, or unverifiable lifecycle aborts
    // the whole transaction. No health/history/outbox/manual-run writes occur.
    for (const slot of [0, 1, 2, 3, 4]) {
      const lock = await client.query("SELECT pg_try_advisory_xact_lock($1,$2) AS locked", [namespace, slot]);
      if (!lock.rows[0]?.locked) throw Error("A browser admission owner is still connected; quarantine retained.");
    }
    const row = (await client.query("SELECT active_token FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE")).rows[0];
    if (row?.active_token !== expectedToken) throw Error("Quarantine token changed; recovery refused.");
    await verifyFence();
    await client.query("UPDATE fusion_chromium_scheduler SET active_token=NULL,active_workload=NULL,active_since=NULL,priority_window_until=NULL,last_interactive_at=NULL,scheduled_turn_until=NULL,scheduled_recovery_pending=false WHERE id=1 AND active_token=$1", [expectedToken]);
    // All old processes are fenced. Durable manual runs remain queued/running
    // and a replacement Worker renews their intents under the monitor lock.
    await client.query("UPDATE fusion_chromium_priority_intents SET cancelled_at=now() WHERE cancelled_at IS NULL");
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let pool: Pool | undefined;
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || args[0] !== "--confirm-all-replicas-fenced" || args[1] !== "--confirm-controllers-paused")
      throw Error("Offline recovery requires both operator confirmations, followed by token, daemon ID, Compose project and comma-separated full container IDs. See docs/chromium-recovery.md.");
    const [, , token, daemonId, project, ids] = args;
    if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required; do not put credentials in command arguments.");
    pool = makePool(process.env.DATABASE_URL);
    await recoverChromiumQuarantine(pool, token, () => verifyStoppedContainers({ daemonId, project, containerIds: ids.split(",") }));
    console.log("Chromium quarantine recovered after verified container fencing. Start only a coordinated single-slot API/Worker revision.");
  } catch {
    // Driver/Docker errors can contain connection strings or runtime metadata.
    // Never serialize them. Detailed preconditions are documented offline.
    console.error("Chromium recovery refused or failed. Quarantine must be treated as retained until its database token is checked. Verify fencing scope, stopped containers, disabled restarts, database health and expected token; see docs/chromium-recovery.md.");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
