import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ManualRunStatus } from "./ManualRunStatus";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("exposes queued, running, completed and failed manual outcomes and aborts on navigation", async () => {
  vi.mocked(api).mockResolvedValue({ status: "queued" });
  const view = render(<ManualRunStatus id="fixture" refresh={0} />);
  expect(await screen.findByRole("status")).toHaveTextContent("Check now queued");
  for (const [refresh, status] of ["running", "completed", "failed"].entries()) {
    vi.mocked(api).mockResolvedValue({ status });
    view.rerender(<ManualRunStatus id="fixture" refresh={refresh + 1} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(`Check now ${status}`));
  }
  const signal = vi.mocked(api).mock.calls.at(-1)?.[3]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
