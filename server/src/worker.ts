import type { Pool } from "./db.js";
import type { Config } from "./config.js";
import { capture } from "./capture.js";
import { runMonitor, type CaptureFailureDiagnostic } from "./engine.js";
import { dispatch } from "./outbox.js";
import { deliver } from "./notifications.js";
import { acquireChromiumLease } from "./chromium-capacity.js";
import { isWorkerFatalError } from "./errors.js";
export async function workerCycle(
  pool: Pool,
  cfg: Config,
  options: {
    capture?: typeof capture;
    send?: typeof deliver;
    stopped?: () => boolean;
    onFailure?: (diagnostic: CaptureFailureDiagnostic) => void;
  } = {},
) {
  const due = await pool.query(
    "SELECT id,kind,text_source,text_enabled,visual_enabled FROM fusion_monitors WHERE enabled AND NOT paused AND next_run<=now() ORDER BY next_run LIMIT 5",
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: cfg.CHROMIUM_CONCURRENCY }, async () => {
      while (next < due.rows.length && !options.stopped?.()) {
        const monitor = due.rows[next++];
        const usesChromium = monitor.kind === "browser" && (monitor.visual_enabled || (monitor.text_enabled && monitor.text_source !== "jina"));
        const capacity = usesChromium && !options.capture
          ? await acquireChromiumLease(pool, { workload: "capture", slots: cfg.CHROMIUM_CONCURRENCY, waitMs: 1_000 })
          : null;
        // Capacity contention is not a capture failure. Keep next_run due so a
        // later cycle can prefer this scheduled monitor over a new preview.
        if (usesChromium && !options.capture && !capacity) continue;
        let fatalCleanup = false;
        try {
          await runMonitor(pool, cfg, monitor.id, {
            capture: options.capture,
            onFailure: options.onFailure,
          });
        } catch (error) {
          fatalCleanup = isWorkerFatalError(error);
          throw error;
        } finally {
          if (!fatalCleanup) await capacity?.release();
        }
      }
    }),
  );
  await dispatch(pool, cfg, options.send, { stopped: options.stopped });
}
