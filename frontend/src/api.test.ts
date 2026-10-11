import { it, expect, vi } from "vitest";
import { ApiError, api } from "./api";
it("expired/revoked sessions emit a reauthentication event; invalid current passwords do not sign the user out", async () => {
  const listener = vi.fn();
  window.addEventListener("fusion-session-expired", listener);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce({
      status: 401,
      ok: false,
      json: async () => ({ error: "Authentication required" }),
    })
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
