import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makePool, type Pool } from "./db.js";
import { createHash } from "node:crypto";
export async function migrate(pool: Pool) {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(741901)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS fusion_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const dir = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(dir))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(name, dir), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await c.query(
        "SELECT checksum FROM fusion_migrations WHERE name=$1",
        [name],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum)
          throw Error("Applied migration changed: " + name);
        continue;
      }
      await c.query("BEGIN");
      try {
        await c.query(sql);
        await c.query(
          "INSERT INTO fusion_migrations(name,checksum) VALUES($1,$2)",
          [name, checksum],
        );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(741901)");
    c.release();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = makePool(process.env.DATABASE_URL ?? "");
  try {
    await migrate(pool);
    console.log("Migrations applied");
  } finally {
    await pool.end();
  }
}
