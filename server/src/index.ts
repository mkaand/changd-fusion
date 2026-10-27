import { readConfig } from "./config.js";
import { makePool } from "./db.js";
import { createApp } from "./app.js";
import pino from "pino";
import { closeRegionPreviewSessions } from "./region-picker.js";
const cfg = readConfig(),
  pool = makePool(cfg.DATABASE_URL),
  log = pino({ level: cfg.LOG_LEVEL });
await pool.query("SELECT 1");
const server = createApp(pool, cfg).listen(cfg.PORT, () =>
  log.info({ port: cfg.PORT }, "Changd Fusion API started"),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const watchdog = setTimeout(() => process.exit(1), 140_000).unref();
    server.close(() => void (async () => {
      try {
        // Keep PostgreSQL available until every retained session has completed
        // browser/proxy cleanup and cleared its durable ownership token.
        await closeRegionPreviewSessions();
        await pool.end();
      } finally { clearTimeout(watchdog); }
    })());
  });
