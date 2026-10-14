import { it, expect, vi } from "vitest";
import { ApiError, api } from "./api";
it("expired/revoked sessions attempt one refresh before reauthentication; invalid current passwords do not sign the user out", async () => {
  const listener = vi.fn();
  window.addEventListener("fusion-session-expired", listener);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      status: 401,
      ok: false,
      json: async () => ({ error: "Authentication required" }),
    })
    .mockResolvedValueOnce({ status: 401, ok: false })
    .mockResolvedValueOnce({
      status: 401,
      ok: false,
      json: async () => ({ error: "Invalid password" }),
    });
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(api("/jobs")).rejects.toThrow("Authentication required");
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(api("/users/changepassword", "POST", {})).rejects.toThrow(
      "Invalid password",
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].credentials).toBe("same-origin");
    expect(fetcher.mock.calls[1][0]).toBe("/api/v1/session/refresh");
    expect(fetcher.mock.calls[0][1].signal).toBeDefined();
  } finally {
    window.removeEventListener("fusion-session-expired", listener);
    vi.unstubAllGlobals();
  }
});

it("turns a non-JSON diagnostics failure into a safe API error with a request ID", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502, headers: { "x-request-id": "safe-request-id" } })));
  await expect(api("/system/diagnostics")).rejects.toMatchObject<ApiError>({
    name: "ApiError", message: "Request failed. Retry.", requestId: "safe-request-id", status: 502,
  });
});

it("rotates the refresh session once and retries an active request without signing out", async () => {
  const listener = vi.fn();
  window.addEventListener("fusion-session-expired", listener);
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ status: 401, ok: false, json: async () => ({ error: "Authentication required" }) })
    .mockResolvedValueOnce({ status: 200, ok: true })
    .mockResolvedValueOnce({ status: 200, ok: true, json: async () => ({ id: "monitor-1" }) });
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(api("/jobs/monitor-1")).resolves.toEqual({ id: "monitor-1" });
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/jobs/monitor-1", "/api/v1/session/refresh", "/api/v1/jobs/monitor-1",
    ]);
    expect(listener).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("fusion-session-expired", listener);
    vi.unstubAllGlobals();
  }
});
