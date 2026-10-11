import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Timeline } from "./Timeline";
import { Analytics } from "./Analytics";
import { api } from "./api";
vi.mock("./api", () => ({ api: vi.fn(), percent: (value: string | null) => value === null ? "—" : value + "%" }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const monitor = { id: "1c2e3478-661d-4f87-a5e2-4d79b9e6a742", name: "Release tracker" };
it("renders a filtered owner timeline from the timeline API", async () => {
  vi.mocked(api).mockResolvedValue({ items: [{ id: "event", monitor_name: "Release tracker", status: "changed", created_at: "2026-10-11T12:00:00.000Z", text_changed: true, visual_changed: false, visual_percent: null }], total: 1, page: 1 });
  render(<Timeline monitors={[monitor]} />);
  expect(await screen.findByText("Release tracker")).toBeInTheDocument();
  expect(screen.getByText("Text changed")).toBeInTheDocument();
  expect(vi.mocked(api).mock.calls[0][0]).toContain("/timeline?");
  expect(vi.mocked(api).mock.calls[0][0]).toContain("page_size=25");
});
it("renders analytics totals, trend, and event distribution from one owner-scoped endpoint", async () => {
  vi.mocked(api).mockResolvedValue({ summary: { total: "6", changed: "2", successful: "5", failed: "1" }, distribution: [{ status: "changed", count: 2 }], trend: [{ day: "2026-10-10", total: 3, changed: 1, failed: 0, successful: 3 }, { day: "2026-10-11", total: 3, changed: 1, failed: 1, successful: 2 }] });
  render(<Analytics monitors={[monitor]} />);
  expect(await screen.findByText("Successful captures")).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Daily capture event trend" })).toBeInTheDocument();
  expect(screen.getByText("changed")).toBeInTheDocument();
  expect(vi.mocked(api).mock.calls[0][0]).toContain("/analytics?");
});
