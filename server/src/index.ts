import { readConfig } from "./config.js";
import { makePool } from "./db.js";
import { createApp } from "./app.js";
import pino from "pino";
const cfg = readConfig(),
  pool = makePool(cfg.DATABASE_URL),
  log = pino({ level: cfg.LOG_LEVEL });
await pool.query("SELECT 1");
const server = createApp(pool, cfg).listen(cfg.PORT, () =>
  log.info({ port: cfg.PORT }, "Changd Fusion API started"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(() => void pool.end());
  });
