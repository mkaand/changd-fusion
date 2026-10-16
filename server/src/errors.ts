export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const captureStages = [
  "target_validation",
  "proxy_initialization",
  "browser_launch",
  "browser_context",
  "navigation",
  "browser_steps",
  "attention_detection",
  "font_wait",
  "text_extraction",
  "screenshot",
  "selector_lookup",
  "visibility_validation",
  "scroll_into_view",
  "element_stability",
  "screenshot_rasterization",
  "image_validation",
  "cleanup",
  "comparison",
  "storage",
  "database",
  "unknown",
] as const;
export type CaptureStage = (typeof captureStages)[number];
export const captureFailureCodes = [
  "timeout",
  "http_403",
  "http_429",
  "http_5xx",
  "dns_failure",
  "connection_failure",
  "tls_failure",
  "egress_denied",
  "browser_launch_failed",
  "browser_crashed",
  "navigation_failed",
  "selector_failed",
  "selector_missing",
  "selector_ambiguous",
  "element_not_visible",
  "element_unstable",
  "screenshot_timeout",
  "capacity_busy",
  "resource_limit",
  "capture_failed",
  "cleanup_timeout",
  "internal_error",
  "unknown",
] as const;
export type CaptureFailureCode = (typeof captureFailureCodes)[number];
export type CaptureTimings = Partial<Record<CaptureStage, number>>;

export class CaptureFailure extends Error {
  constructor(
    public stage: CaptureStage,
    public code: CaptureFailureCode,
    message = "Website capture failed. Check monitor diagnostics.",
    public httpStatus: number | null = null,
    public timings?: CaptureTimings,
  ) {
    super(message);
  }
}

export class WorkerFatalError extends Error {
  readonly code = "cleanup_timeout" as const;
  constructor(public resource: "browser" | "proxy", public timings?: CaptureTimings) {
    super("Capture cleanup did not complete before its safety deadline.");
    this.name = "WorkerFatalError";
  }
}

export function isWorkerFatalError(error: unknown): error is WorkerFatalError {
  return error instanceof WorkerFatalError;
}

// This deliberately examines only stable error names, safe HttpError messages
// produced by this application, and HTTP status values. It never returns an
// upstream exception message, URL, selector, page content, or credentials.
export function captureFailure(
  error: unknown,
  stage: CaptureStage,
): CaptureFailure {
  if (error instanceof CaptureFailure) return error;
  if (error instanceof HttpError) {
    const message = error.message;
    if (/HTTP 403/.test(message))
      return new CaptureFailure(stage, "http_403", message, 403);
    if (/HTTP 429/.test(message))
      return new CaptureFailure(stage, "http_429", message, 429);
    if (/HTTP 5\d\d/.test(message)) {
      const status = Number(message.match(/HTTP (5\d\d)/)?.[1]) || null;
      return new CaptureFailure(stage, "http_5xx", message, status);
    }
    if (/selector|region/i.test(message))
      return new CaptureFailure(stage, "selector_failed", message);
    if (/DNS resolution/i.test(message))
      return new CaptureFailure(stage, "dns_failure");
    if (/not permitted|private destinations|blocked/i.test(message))
      return new CaptureFailure(stage, "egress_denied");
    if (/time budget|timeout/i.test(message))
      return new CaptureFailure(stage, "timeout");
    if (/redirect/i.test(message))
      return new CaptureFailure(stage, "navigation_failed");
    return new CaptureFailure(stage, "capture_failed", message);
  }
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(name) || /timeout/i.test(message))
    return new CaptureFailure(stage, stage === "screenshot_rasterization" ? "screenshot_timeout" : "timeout");
  if (/dns|enotfound|getaddrinfo/i.test(message))
    return new CaptureFailure(stage, "dns_failure");
  if (/tls|certificate|ssl/i.test(message))
    return new CaptureFailure(stage, "tls_failure");
  if (/econn|connection|socket/i.test(message))
    return new CaptureFailure(stage, "connection_failure");
  if (stage === "browser_launch")
    return new CaptureFailure(stage, /crash|closed/i.test(message) ? "browser_crashed" : "browser_launch_failed");
  if (stage === "navigation") return new CaptureFailure(stage, "navigation_failed");
  if (stage === "browser_steps") return new CaptureFailure(stage, "capture_failed");
  if (stage === "text_extraction" && /large|limit/i.test(message))
    return new CaptureFailure(stage, "resource_limit");
  if ((stage === "screenshot" || stage === "image_validation") && /limit|dimension|pixel/i.test(message))
    return new CaptureFailure(stage, "resource_limit");
  return new CaptureFailure(stage, "unknown");
}

export function publicFailure(e: unknown): string {
  if (e instanceof CaptureFailure) return e.message;
  if (e instanceof HttpError && e.status < 500) return e.message;
  return "Operation failed. Check configuration and retry.";
}
