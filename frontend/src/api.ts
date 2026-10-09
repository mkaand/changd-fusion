export async function api<T = any>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch("/api/v1" + path, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Fusion-Request": "1" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result;
}
export const loginUser = (values: { email: string; password: string }) =>
  api("/login", "POST", values);
export const percent = (value: string | null) =>
  value === null
    ? "—"
    : value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") + "%";
