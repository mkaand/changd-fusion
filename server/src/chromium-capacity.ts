import type pg from "pg";
import type { Pool } from "./db.js";

// Session advisory locks coordinate the API and worker even though they run in
// separate containers. A lease deliberately owns a dedicated pool connection
// for the lifetime of the Chromium process tree (and a resident preview).
const LOCK_NAMESPACE = 0x43484645; // "CHFE"
const PRIORITY_GATE = 0;
const POLL_MS = 50;

export type ChromiumWorkload = "capture" | "preview";

export type ChromiumLease = {
  readonly workload: ChromiumWorkload;
  readonly slot: number;
  release(): Promise<void>;
};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function tryLock(client: pg.PoolClient, shared: boolean, slot: number) {
  const fn = shared ? "pg_try_advisory_lock_shared" : "pg_try_advisory_lock";
  const result = await client.query<{ locked: boolean }>(`SELECT ${fn}($1, $2) AS locked`, [LOCK_NAMESPACE, slot]);
  return result.rows[0]?.locked === true;
}

async function unlock(client: pg.PoolClient, shared: boolean, slot: number) {
  const fn = shared ? "pg_advisory_unlock_shared" : "pg_advisory_unlock";
  const result = await client.query<{ unlocked: boolean }>(`SELECT ${fn}($1, $2) AS unlocked`, [LOCK_NAMESPACE, slot]);
  return result.rows[0]?.unlocked === true;
}

function lease(client: pg.PoolClient, workload: ChromiumWorkload, slot: number): ChromiumLease {
  let released = false;
  return {
    workload,
    slot,
    async release() {
      if (released) return;
      released = true;
      let clean = false;
      try { clean = await unlock(client, false, slot); }
      finally { client.release(!clean); }
    },
  };
}

/**
 * Acquire one global Chromium slot. Captures briefly take an exclusive gate
 * while looking for a slot; previews use a shared, non-waiting gate. This
 * gives scheduled monitoring preference without holding a database lock while
 * Chromium is running.
 */
export async function acquireChromiumLease(
  pool: Pool,
  options: { workload: ChromiumWorkload; slots: number; waitMs?: number; signal?: AbortSignal },
): Promise<ChromiumLease | null> {
  const slots = Math.max(1, Math.min(3, Math.trunc(options.slots)));
  const waitMs = options.workload === "capture" ? Math.max(0, options.waitMs ?? 1_000) : 0;
  const deadline = Date.now() + waitMs;
  const client = await pool.connect();
  let gateHeld = false;
  let clean = true;
  let leased = false;
  try {
    do {
      if (options.signal?.aborted) return null;
      if (!gateHeld) gateHeld = await tryLock(client, options.workload === "preview", PRIORITY_GATE);
      if (!gateHeld) {
        if (options.workload === "preview" || Date.now() >= deadline) return null;
        await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
        continue;
      }
      for (let slot = 1; slot <= slots; slot++) {
        if (await tryLock(client, false, slot)) {
          if (!await unlock(client, options.workload === "preview", PRIORITY_GATE)) clean = false;
          gateHeld = false;
          if (!clean) {
            await unlock(client, false, slot).catch(() => false);
            return null;
          }
          leased = true;
          return lease(client, options.workload, slot);
        }
      }
      if (options.workload === "preview" || Date.now() >= deadline) {
        if (!await unlock(client, options.workload === "preview", PRIORITY_GATE)) clean = false;
        gateHeld = false;
        return null;
      }
      if (!clean) return null;
      // A waiting capture retains the exclusive gate so a stream of optional
      // previews cannot starve scheduled monitoring. The gate is released as
      // soon as a slot is acquired or this short admission deadline expires.
      await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return null;
  } catch (error) {
    clean = false;
    throw error;
  } finally {
    if (gateHeld) clean = await unlock(client, options.workload === "preview", PRIORITY_GATE).catch(() => false) && clean;
    // A returned lease owns the client; otherwise release it here.
    if (!leased) client.release(!clean);
  }
}
