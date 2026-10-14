import { hash } from "bcryptjs";
import { z } from "zod";
import { transaction, type Pool } from "./db.js";

export const administratorPassword = z.string()
  .min(12)
  .max(72)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72);

export async function resetOnlyActiveAdministratorPassword(pool: Pool, password: string) {
  const validated = administratorPassword.parse(password);
  await transaction(pool, async (client) => {
    const administrators = await client.query(
      "SELECT user_id FROM users WHERE user_type=2 AND status=1 ORDER BY user_id LIMIT 2 FOR UPDATE",
    );
    if (administrators.rowCount !== 1) throw new Error("Exactly one active administrator is required");
    const userId = administrators.rows[0].user_id;
    await client.query("UPDATE users SET password=$2 WHERE user_id=$1", [userId, await hash(validated, 12)]);
    await client.query("UPDATE fusion_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
    await client.query("UPDATE fusion_security_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
  });
}
