export class ApiError extends Error {
  requestId?: string;
  previewStage?: string;
  failureCode?: string;
  previewStep?: number;
  previewAction?: string;
  durationMs?: number;
  status?: number;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    Object.assign(this, {
      requestId: details.request_id,
      previewStage: details.preview_stage,
      failureCode: details.failure_code,
      previewStep: details.step,
      previewAction: details.action,
      durationMs: details.duration_ms,
      status: details.status,
    });
  }
}
let refreshInFlight: Promise<void> | undefined;

async function refreshAccessSession() {
  const response = await fetch("/api/v1/session/refresh", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Fusion-Request": "1" },
    body: "{}",
  });
  if (!response.ok) throw Error("Authentication required");
}

export async function api<T = any>(
  path: string,
  method = "GET",
  data?: unknown,
  options?: { signal?: AbortSignal; timeoutMs?: number },
  retriedAfterRefresh = false,
): Promise<T> {
  const timeout = AbortSignal.timeout(options?.timeoutMs ?? 15000);
  let response: Response;
  try { response = await fetch("/api/v1" + path, {
    method,
    signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Fusion-Request": "1" },
    body: data === undefined ? undefined : JSON.stringify(data),
  }); } catch {
    const cancelled = options?.signal?.aborted;
    throw new ApiError(cancelled ? "Request cancelled." : timeout.aborted ? "The client deadline expired before the server responded. Retry the Preview." : "The server could not be reached. Check your connection and retry.", {
      preview_stage: "transport", failure_code: cancelled ? "cancelled" : timeout.aborted ? "client_timeout" : "network_failure",
    });
  }
  const requestId = response.headers?.get?.("x-request-id") ?? undefined;
  let result: any;
  try {
    if (typeof response.text === "function") {
      const body = await response.text();
      result = body ? JSON.parse(body) : {};
    } else {
      result = await response.json();
    }
  } catch {
    throw new ApiError(
      response.ok ? "Server returned an invalid response." : `HTTP ${response.status}: ${response.status === 504 ? "An upstream proxy timed out before a Preview response arrived." : response.status === 502 ? "The upstream service is unavailable." : "The server returned an invalid response."} Retry shortly; manual editing remains available.`,
      { request_id: requestId, status: response.status, preview_stage: "transport", failure_code: response.status === 504 ? "upstream_timeout" : "invalid_response" },
    );
  }
  if (response.status === 401 && result.error === "Authentication required" && path !== "/session/refresh" && !retriedAfterRefresh) {
    try {
      refreshInFlight ??= refreshAccessSession().finally(() => { refreshInFlight = undefined; });
      await refreshInFlight;
      return api(path, method, data, options, true);
    } catch {
      window.dispatchEvent(new Event("fusion-session-expired"));
    }
  } else if (response.status === 401 && result.error === "Authentication required") {
    window.dispatchEvent(new Event("fusion-session-expired"));
  }
  if (!response.ok)
    throw new ApiError(result.error ?? "Request failed", { ...result, request_id: result.request_id ?? requestId, status: response.status });
  return result;
}
export const loginUser = (values: { email: string; password: string }) =>
  api("/login", "POST", values);
export const percent = (value: string | null) =>
  value === null
    ? "—"
    : Number(value).toFixed(2) + "%";
