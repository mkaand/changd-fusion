import type { Pool } from "./db.js";
import { transaction } from "./db.js";
import { randomUUID } from "node:crypto";
import type { PoolClient, QueryConfig } from "pg";
import { CaptureFailure, ChromiumCoordinationLost, SchedulingCancellation } from "./errors.js";

const LOCK_NAMESPACE = 0x43484645;
const SLOT = 1;
export type ChromiumWorkload = "capture" | "preview";
export type ChromiumLease = {
  readonly workload: ChromiumWorkload;
  readonly slot: number;
  readonly signal?: AbortSignal;
  // Only call after browser AND proxy cleanup are confirmed, including aborts.
  release(): Promise<void>;
};

export async function createInteractivePriorityIntent(pool: Pool, ownerId: string, kind: "preview" | "manual", monitorId?: string) {
  const id = await transaction(pool, (c) => registerIntent(c, ownerId, kind, monitorId));
  if (!id) throw priorityBusy();
  return id;
}

function priorityBusy() {
  return new CaptureFailure("browser_launch", "scheduled_recovery", "Scheduled monitoring is taking a bounded recovery turn. Retry shortly.");
}

async function registerIntent(c: PoolClient, ownerId: string, kind: "preview" | "manual", monitorId?: string) {
    const state = (await c.query("SELECT *,scheduled_turn_until>now() AS scheduled_turn,priority_window_until<=now() AND (active_workload='preview' OR last_interactive_at>now()-interval '30 seconds') AS window_expired FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE")).rows[0];
    if (state.scheduled_turn) return null;
    if (state.scheduled_recovery_pending && state.active_workload === "preview") return null;
    if (state.window_expired) {
      await c.query("UPDATE fusion_chromium_scheduler SET priority_window_until=NULL,scheduled_recovery_pending=true,scheduled_turn_until=CASE WHEN active_workload='preview' THEN NULL ELSE now()+interval '30 seconds' END WHERE id=1");
      return null;
    }
    const pending = await c.query("SELECT owner_id FROM fusion_chromium_priority_intents WHERE cancelled_at IS NULL AND expires_at>now()");
    if (pending.rows.length >= 4 || pending.rows.some((r) => r.owner_id === ownerId))
      throw new CaptureFailure("browser_launch", "capacity_queue_full", "An interactive request is already pending. Close it or retry shortly.");
    await c.query("UPDATE fusion_chromium_scheduler SET scheduled_recovery_pending=false,priority_window_until=CASE WHEN priority_window_until IS NULL OR priority_window_until<=now() THEN now()+interval '60 seconds' ELSE priority_window_until END,last_interactive_at=now() WHERE id=1");
    const intent = randomUUID();
    await c.query("INSERT INTO fusion_chromium_priority_intents(id,owner_id,kind,monitor_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '20 seconds')", [intent, ownerId, kind, monitorId ?? null]);
    return intent;
}

export async function enqueueManualRun(pool: Pool, ownerId: string, monitorId: string, needsBrowser: boolean) {
  const result = await transaction(pool, async (c) => {
    await c.query("SELECT id FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE");
    const existing = await c.query("SELECT id,status FROM fusion_manual_runs WHERE monitor_id=$1 AND status IN ('queued','running')", [monitorId]);
    if (existing.rowCount) return existing.rows[0];
    const counts = (await c.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE user_id=$1)::int AS owned FROM fusion_manual_runs WHERE status IN ('queued','running')", [ownerId])).rows[0];
    if (counts.total >= 16 || counts.owned >= 4) throw new CaptureFailure("browser_launch", "capacity_queue_full", "Check now queue is full. Wait for an existing request to finish.");
    const intent = needsBrowser ? await registerIntent(c, ownerId, "manual", monitorId) : null;
    if (needsBrowser && !intent) return null;
    const id = randomUUID();
    await c.query("INSERT INTO fusion_manual_runs(id,monitor_id,user_id,priority_intent_id) VALUES($1,$2,$3,$4)", [id, monitorId, ownerId, intent]);
    return { id, status: "queued" };
  });
  if (!result) throw priorityBusy();
  return result;
}

export async function cancelInteractivePriorityIntent(pool: Pool, id: string | undefined) {
  if (id) await pool.query("UPDATE fusion_chromium_priority_intents SET cancelled_at=now() WHERE id=$1 AND cancelled_at IS NULL", [id]);
}

function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

export async function acquireChromiumLease(pool: Pool, options: {
  workload: ChromiumWorkload; slots: number; waitMs?: number;
  signal?: AbortSignal; onWait?: () => void; priorityIntentId?: string;
  observeInteractivePriority?: boolean;
}): Promise<ChromiumLease | null> {
  const deadline = Date.now() + Math.min(15_000, Math.max(0, options.waitMs ?? 0));
  do {
    if (options.signal?.aborted) return null;
    const client = await pool.connect();
    const token = randomUUID();
    let held = false, admitted = false, clean = true, released = false, checking = false, protectedTurn = false;
    const loss = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const lost = () => { clean = false; loss.abort(new ChromiumCoordinationLost()); };
    client.on?.("error", lost); client.on?.("end", lost);
    const dispose = () => {
      if (timer) clearInterval(timer);
      client.off?.("error", lost); client.off?.("end", lost);
      client.release(!clean);
    };
    try {
      held = (await client.query("SELECT pg_try_advisory_lock($1,$2) AS locked", [LOCK_NAMESPACE, SLOT])).rows[0]?.locked === true;
      if (held) {
        await client.query("BEGIN");
        try {
          const state = (await client.query("SELECT *,scheduled_turn_until>now() AS scheduled_turn FROM fusion_chromium_scheduler WHERE id=1 FOR UPDATE")).rows[0];
          // A DB lock disappearing does not prove that an old browser exited.
          if (state.active_token) throw new CaptureFailure("browser_launch", "cleanup_timeout", "Browser cleanup is unconfirmed. Supervised recovery is required before another browser can start.");
          const intents = await client.query("SELECT id FROM fusion_chromium_priority_intents WHERE cancelled_at IS NULL AND expires_at>now() ORDER BY created_at,id");
          const head = intents.rows[0]?.id;
          const allowed = options.workload === "capture"
            ? state.scheduled_turn || !head
            : !state.scheduled_turn && (options.priorityIntentId ? head === options.priorityIntentId : !head);
          if (allowed && !options.signal?.aborted) {
            protectedTurn = options.workload === "capture" && Boolean(state.scheduled_turn);
            await client.query("UPDATE fusion_chromium_scheduler SET active_token=$1,active_workload=$2,active_since=now(),scheduled_recovery_pending=CASE WHEN $2='capture' THEN false ELSE scheduled_recovery_pending END WHERE id=1", [token, options.workload]);
            admitted = true;
          }
          await client.query("COMMIT");
        } catch (error) { admitted = false; await client.query("ROLLBACK").catch(() => {}); throw error; }
        if (!admitted) {
          await client.query("SELECT pg_advisory_unlock($1,$2)", [LOCK_NAMESPACE, SLOT]);
          held = false;
        }
      }
      if (admitted) {
        timer = setInterval(() => {
          if (checking || released || loss.signal.aborted) return;
          checking = true;
          // A server-side statement timeout cannot detect a partition or a
          // paused database. The client deadline also aborts browser work when
          // coordination becomes uncertain, without advertising free capacity.
          const heartbeat: QueryConfig & { query_timeout: number } = {
            text: "SELECT active_token=$1 AS owned,scheduled_recovery_pending,EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=$2 AND objid=$3 AND objsubid=2 AND granted) AS locked,EXISTS(SELECT 1 FROM fusion_chromium_priority_intents WHERE cancelled_at IS NULL AND expires_at>now()) AND COALESCE(scheduled_turn_until<=now(),true) AS requested FROM fusion_chromium_scheduler WHERE id=1",
            values: [token, LOCK_NAMESPACE, SLOT], query_timeout: 1000,
          };
          void client.query<{ requested: boolean; owned: boolean; locked: boolean; scheduled_recovery_pending: boolean }>(heartbeat)
            .then((r) => {
              if (released) return;
              if (!r.rows[0]?.owned || !r.rows[0]?.locked) { lost(); return; }
              // A recovery turn also protects a scheduled capture that was
              // already running when the burst expired, not just new admission.
              if (options.workload === "capture" && r.rows[0].scheduled_recovery_pending) protectedTurn = true;
              if (!protectedTurn && options.observeInteractivePriority && options.workload === "capture" && r.rows[0].requested) loss.abort(new SchedulingCancellation());
            })
            .catch(lost).finally(() => { checking = false; });
        }, 100);
        timer.unref();
        return { workload: options.workload, slot: SLOT, signal: loss.signal, async release() {
          if (released) return;
          released = true;
          if (timer) clearInterval(timer);
          try {
            // Called only after cleanup; the token also fences lease-loss recovery.
            await pool.query("UPDATE fusion_chromium_scheduler SET last_interactive_at=CASE WHEN active_workload='preview' THEN now() ELSE last_interactive_at END,scheduled_turn_until=CASE WHEN scheduled_recovery_pending AND active_workload='preview' THEN now()+interval '30 seconds' ELSE scheduled_turn_until END,active_token=NULL,active_workload=NULL,active_since=NULL WHERE id=1 AND active_token=$1", [token]);
            await cancelInteractivePriorityIntent(pool, options.priorityIntentId);
            if (clean) clean = (await client.query("SELECT pg_advisory_unlock($1,$2) AS unlocked", [LOCK_NAMESPACE, SLOT])).rows[0]?.unlocked === true;
          } catch (error) { clean = false; throw error; }
          finally { dispose(); }
        } };
      }
    } catch (error) { clean = false; throw error; }
    finally {
      if (!admitted) {
        if (held && clean) await client.query("SELECT pg_advisory_unlock($1,$2)", [LOCK_NAMESPACE, SLOT]).catch(() => { clean = false; });
        dispose();
      }
    }
    if (Date.now() >= deadline) return null;
    options.onWait?.();
    await pause(Math.min(50, Math.max(1, deadline - Date.now())), options.signal);
  } while (Date.now() < deadline);
  return null;
}
