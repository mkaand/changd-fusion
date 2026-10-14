import { test } from "node:test";
import assert from "node:assert/strict";
import { resetOnlyActiveAdministratorPassword } from "../src/admin-password-reset.js";

test("administrator reset updates only one active admin and revokes account access", async () => {
  const queries: { sql: string; values?: unknown[] }[] = [];
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.startsWith("SELECT user_id FROM users")) return { rowCount: 1, rows: [{ user_id: "admin-1" }] };
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };
  await resetOnlyActiveAdministratorPassword({ connect: async () => client } as any, "secure-fixture-password");
  const update = queries.find(({ sql }) => sql.startsWith("UPDATE users SET password"));
  assert.equal(update?.values?.[0], "admin-1");
  assert.notEqual(update?.values?.[1], "secure-fixture-password");
  assert.ok(queries.some(({ sql }) => sql.startsWith("UPDATE fusion_sessions SET revoked_at")));
  assert.ok(queries.some(({ sql }) => sql.startsWith("UPDATE fusion_security_grants SET revoked_at")));
});

test("administrator reset rejects missing or ambiguous active administrators without writes", async () => {
  for (const rowCount of [0, 2]) {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.startsWith("SELECT user_id FROM users")) return { rowCount, rows: [] };
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };
    await assert.rejects(resetOnlyActiveAdministratorPassword({ connect: async () => client } as any, "secure-fixture-password"), /Exactly one active administrator/);
    assert.ok(!queries.some((sql) => sql.startsWith("UPDATE users SET password")));
  }
});
