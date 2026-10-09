import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  CHANNEL_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  DATA_DIR: z.string().default("./data/fusion"),
  REGISTRATION_ENABLED: z.enum(["true", "false"]).default("false"),
  HISTORY_DAYS: z.coerce.number().int().min(1).default(90),
  CAPTURE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120000)
    .default(30000),
  PLAYWRIGHT_EXECUTABLE_PATH: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
