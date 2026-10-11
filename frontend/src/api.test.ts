import { it, expect, vi } from "vitest";
import { api } from "./api";
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
