import { readConfig } from "./config.js";
import { makePool } from "./db.js";
import { retainHistory } from "./engine.js";
import { workerCycle } from "./worker.js";
import pino from "pino";
const cfg = readConfig(),
  pool = makePool(cfg.DATABASE_URL),
  log = pino({ level: cfg.LOG_LEVEL });
let stopped = false;
let cleanup = 0;
let shutdownTimer: NodeJS.Timeout | undefined;
function stop() {
  stopped = true;
  // Capture has its own deadline. This is a final process-level backstop for broken drivers/providers.
  shutdownTimer ??= setTimeout(() => {
    log.error(
      { code: "worker_shutdown_deadline" },
      "Graceful shutdown exceeded deadline",
    );
    process.exit(1);
  }, cfg.CAPTURE_TIMEOUT_MS + 30000).unref();
}
process.on("SIGTERM", () => {
  stop();
});
process.on("SIGINT", () => {
  stop();
});
try {
  while (!stopped) {
    try {
      await workerCycle(pool, cfg, { stopped: () => stopped });
      if (Date.now() - cleanup > 3600000) {
        await retainHistory(pool, cfg);
        cleanup = Date.now();
      }
    } catch {
      log.error({ code: "worker_cycle_failed" }, "Worker cycle failed");
    }
    if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await pool.end();
  if (shutdownTimer) clearTimeout(shutdownTimer);
}
