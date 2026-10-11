import "dotenv/config";
import { makePool } from "./db.js";
import { migrate } from "./migrate.js";
import { hash } from "bcryptjs";
import { z } from "zod";
// Read from environment, never command-line arguments or logs.
const input = z
  .object({
    ADMIN_EMAIL: z.email(),
    ADMIN_PASSWORD: z
      .string()
      .min(12)
      .max(72)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 72),
  })
  .parse(process.env);
const pool = makePool(process.env.DATABASE_URL ?? "");
try {
  await migrate(pool);
  await pool.query(
    "INSERT INTO users(email,password,firstname,lastname,user_type) VALUES($1,$2,$3,$4,2)",
    [
      input.ADMIN_EMAIL.toLowerCase(),
      await hash(input.ADMIN_PASSWORD, 12),
      "Administrator",
      "",
    ],
  );
  console.log("Administrator created");
} finally {
  await pool.end();
}
