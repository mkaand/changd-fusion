import type { Pool } from "./db.js";
import type { Config } from "./config.js";
import { capture } from "./capture.js";
import { runMonitor } from "./engine.js";
import { dispatch } from "./outbox.js";
import { deliver } from "./notifications.js";
export async function workerCycle(
  pool: Pool,
  cfg: Config,
  options: {
    capture?: typeof capture;
    send?: typeof deliver;
    stopped?: () => boolean;
  } = {},
) {
  const due = await pool.query(
    "SELECT id FROM fusion_monitors WHERE enabled AND NOT paused AND next_run<=now() ORDER BY next_run LIMIT 5",
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: cfg.CHROMIUM_CONCURRENCY }, async () => {
      while (next < due.rows.length && !options.stopped?.()) {
        const { id } = due.rows[next++];
        await runMonitor(pool, cfg, id, { capture: options.capture });
      }
    }),
  );
  await dispatch(pool, cfg, options.send, { stopped: options.stopped });
}
