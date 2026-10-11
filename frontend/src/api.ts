export class ApiError extends Error {
  requestId?: string;
  previewStage?: string;
  failureCode?: string;
  durationMs?: number;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    Object.assign(this, {
      requestId: details.request_id,
      previewStage: details.preview_stage,
      failureCode: details.failure_code,
      durationMs: details.duration_ms,
    });
  }
}
export async function api<T = any>(
  path: string,
  method = "GET",
  data?: unknown,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const timeout = AbortSignal.timeout(options?.timeoutMs ?? 15000);
  const response = await fetch("/api/v1" + path, {
    method,
    signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Fusion-Request": "1" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (response.status === 401 && result.error === "Authentication required")
    window.dispatchEvent(new Event("fusion-session-expired"));
  if (!response.ok) throw new ApiError(result.error ?? "Request failed", result);
  return result;
}
export const loginUser = (values: { email: string; password: string }) =>
  api("/login", "POST", values);
export const percent = (value: string | null) =>
  value === null
    ? "—"
    : value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "%";
