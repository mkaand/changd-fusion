import { readConfig } from "./config.js";
import { MAX_MONITOR_CAPTURE_TIMEOUT_MS } from "./capture-timeout.js";
import { makePool } from "./db.js";
import { retainHistory } from "./engine.js";
import { workerCycle } from "./worker.js";
import { isWorkerFatalError } from "./errors.js";
import pino from "pino";
import { WorkerReadiness } from "./worker-readiness.js";
const cfg = readConfig(),
  pool = makePool(cfg.DATABASE_URL),
  log = pino({ level: cfg.LOG_LEVEL }),
  readiness = WorkerReadiness.system(process.env.APP_COMMIT ?? "development");
let stopped = false;
let cleanup = 0;
let shutdownTimer: NodeJS.Timeout | undefined;
function stop() {
  stopped = true;
  readiness.stopping();
  // Capture has its own deadline. This is a final process-level backstop for broken drivers/providers.
  shutdownTimer ??= setTimeout(() => {
    log.error(
      { code: "worker_shutdown_deadline" },
      "Graceful shutdown exceeded deadline",
    );
    process.exit(1);
  }, Math.max(cfg.CAPTURE_TIMEOUT_MS, MAX_MONITOR_CAPTURE_TIMEOUT_MS) + 30000).unref();
}
readiness.start();
process.on("SIGTERM", () => {
  stop();
});
process.on("SIGINT", () => {
  stop();
});
try {
  while (!stopped) {
    try {
      await workerCycle(pool, cfg, {
        stopped: () => stopped,
        onFailure: (diagnostic) =>
          log.warn(
            {
              code: "capture_failed",
              monitor_id: diagnostic.monitorId,
              stage: diagnostic.stage,
              failure_code: diagnostic.code,
              http_status: diagnostic.httpStatus,
              duration_ms: diagnostic.durationMs,
              timings: diagnostic.timings,
              worker_pid: process.pid,
              rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            },
            "Monitor capture failed",
          ),
        onProgress: (event) => {
          if (event.kind === "initialized") readiness.initializedProgress();
          else if (event.kind === "monitor-started") readiness.busy("monitor", event.maxDurationMs);
          else if (event.kind === "outbox-progress") readiness.busy("outbox");
          else if (event.kind === "monitor-finished" || event.kind === "outbox-finished") readiness.cycleSucceeded();
        },
      });
      readiness.cycleSucceeded();
      if (Date.now() - cleanup > 3600000) {
        readiness.busy("retention");
        await retainHistory(pool, cfg);
        readiness.cycleSucceeded();
        cleanup = Date.now();
      }
    } catch (error) {
      if (isWorkerFatalError(error)) {
        readiness.fatal();
        log.fatal(
          { code: "worker_cleanup_watchdog", resource: error.resource, timings: error.timings, worker_pid: process.pid },
          "Capture cleanup watchdog triggered; exiting for supervised restart",
        );
        process.exit(1);
      }
      readiness.cycleFailed();
      log.error({ code: "worker_cycle_failed" }, "Worker cycle failed");
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  readiness.stopping();
  await pool.end();
  if (shutdownTimer) clearTimeout(shutdownTimer);
}
