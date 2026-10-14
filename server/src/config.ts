import "dotenv/config";
import { z } from "zod";
const optionalText = (max: number) => z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).max(max).optional());
const optionalPort = z.preprocess((value) => value === "" ? undefined : value, z.coerce.number().int().refine((value) => value === 465 || value === 587).optional());
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  CHANNEL_KEY: z.string().regex(/^[a-f\d]{64}$/i),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  RECOVERY_SMTP_HOST: optionalText(253),
  RECOVERY_SMTP_PORT: optionalPort,
  RECOVERY_SMTP_USERNAME: optionalText(256),
  RECOVERY_SMTP_PASSWORD: optionalText(512),
  RECOVERY_SMTP_FROM: z.preprocess((value) => value === "" ? undefined : value, z.email().optional()),
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
}).superRefine((value, ctx) => {
  const configured = [value.RECOVERY_SMTP_HOST, value.RECOVERY_SMTP_PORT, value.RECOVERY_SMTP_USERNAME, value.RECOVERY_SMTP_PASSWORD, value.RECOVERY_SMTP_FROM].some((entry) => entry !== undefined);
  if (!configured) return;
  for (const key of ["RECOVERY_SMTP_HOST", "RECOVERY_SMTP_PORT", "RECOVERY_SMTP_FROM"] as const)
    if (value[key] === undefined) ctx.addIssue({ code: "custom", path: [key], message: "Recovery SMTP must be configured completely" });
  if ((value.RECOVERY_SMTP_USERNAME === undefined) !== (value.RECOVERY_SMTP_PASSWORD === undefined))
    ctx.addIssue({ code: "custom", path: ["RECOVERY_SMTP_PASSWORD"], message: "Recovery SMTP username and password must be configured together" });
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
