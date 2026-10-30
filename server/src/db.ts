import pg from "pg";
export const makePool = (url: string) => {
  const pool = new pg.Pool({
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    // Bound client-side waits as well: a paused server/network partition cannot
    // enforce its own statement timeout. Uncertain browser leases stay fenced.
    query_timeout: 10000,
    idle_in_transaction_session_timeout: 10000,
  });
  // Idle connection failures must not terminate the service or expose connection strings.
  pool.on("error", () =>
    console.error(
      JSON.stringify({ level: "error", code: "database_pool_error" }),
    ),
  );
  return pool;
};
export type Pool = pg.Pool;
export async function transaction<T>(
  pool: Pool,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  let clean = false;
  try {
    await c.query("BEGIN");
    const value = await fn(c);
    await c.query("COMMIT");
    clean = true;
    return value;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
      clean = true;
    } catch {
      /* Destroy an uncertain transaction below. */
    }
    throw e;
  } finally {
    c.release(!clean);
  }
}
