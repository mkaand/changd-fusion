export async function api<T = any>(
  path: string,
  method = "GET",
  data?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const timeout = AbortSignal.timeout(15000);
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
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}
export const loginUser = (values: { email: string; password: string }) =>
  api("/login", "POST", values);
export const percent = (value: string | null) =>
  value === null
    ? "—"
    : value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "%";
