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
  CHROMIUM_CONCURRENCY: z.coerce.number().int().min(1).max(3).default(1),
  // Optional previews may wait briefly for the existing shared Chromium slot,
  // but their admission budget must remain distinct from browser execution.
  PREVIEW_CAPACITY_WAIT_MS: z.coerce.number().int().min(0).max(60_000).default(15_000),
  MAX_CAPTURE_WIDTH: z.coerce.number().int().min(1280).max(4096).default(4096),
  MAX_CAPTURE_HEIGHT: z.coerce.number().int().min(900).max(8192).default(8192),
  MAX_CAPTURE_PIXELS: z.coerce
    .number()
    .int()
    .min(1280 * 900)
    .max(16_000_000)
    .default(8_000_000),
  PLAYWRIGHT_EXECUTABLE_PATH: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
