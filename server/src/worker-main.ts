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
process.on("SIGTERM", () => {
  stopped = true;
});
process.on("SIGINT", () => {
  stopped = true;
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
}
