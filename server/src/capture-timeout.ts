import { z } from "zod";
import type { Config } from "./config.js";

export const captureTimeoutValues = [30_000, 45_000, 60_000, 75_000, 90_000] as const;
export const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;
export const MAX_MONITOR_CAPTURE_TIMEOUT_MS = 90_000;

export const captureTimeoutSchema = z.union([
  z.literal(30_000),
  z.literal(45_000),
  z.literal(60_000),
  z.literal(75_000),
  z.literal(90_000),
]);

export type CaptureTimeoutMs = z.infer<typeof captureTimeoutSchema>;

export function effectiveCaptureTimeout(
  monitor: { capture_timeout_ms?: number | null },
  cfg: Pick<Config, "CAPTURE_TIMEOUT_MS">,
): number {
  const override = monitor.capture_timeout_ms;
  return captureTimeoutValues.includes(override as CaptureTimeoutMs)
    ? override!
    : cfg.CAPTURE_TIMEOUT_MS;
}
