import type { Pool } from "./db.js";

const LOCK_NAMESPACE = 0x43484645;
// Capture retains the legacy slot. All replicas share one reservation per lane;
// configuration cannot multiply the global limit of two Chromium processes.
const SLOTS = { capture: 1, preview: 4 } as const;
export type ChromiumWorkload = keyof typeof SLOTS;
export type ChromiumLease = {
  readonly workload: ChromiumWorkload;
  readonly slot: number;
  readonly signal?: AbortSignal;
  release(): Promise<void>;
};
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
  signal?: AbortSignal; onWait?: () => void;
}): Promise<ChromiumLease | null> {
  const slot = SLOTS[options.workload];
  const deadline = Date.now() + Math.min(1000, Math.max(0, options.waitMs ?? 0));
  do {
    if (options.signal?.aborted) return null;
    const client = await pool.connect();
    let held = false, clean = true, released = false;
    const loss = new AbortController();
    const lost = () => { clean = false; loss.abort(); };
    client.on?.("error", lost); client.on?.("end", lost);
    const dispose = () => {
      client.off?.("error", lost); client.off?.("end", lost);
      client.release(!clean);
    };
    try {
      if (options.signal?.aborted) return null;
      const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [LOCK_NAMESPACE, slot]);
      held = result.rows[0]?.locked === true;
      if (held) return { workload: options.workload, slot, signal: loss.signal, async release() {
        if (released) return;
        released = true;
        try {
          if (clean) {
            const result = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1, $2) AS unlocked", [LOCK_NAMESPACE, slot]);
            clean = result.rows[0]?.unlocked === true;
          }
        } catch (error) { clean = false; throw error; }
        finally { dispose(); }
      } };
    } catch (error) { clean = false; throw error; }
    finally { if (!held) dispose(); }
    if (Date.now() >= deadline) return null;
    options.onWait?.();
    await pause(Math.min(50, Math.max(1, deadline - Date.now())), options.signal);
  } while (Date.now() < deadline);
  return null;
}
