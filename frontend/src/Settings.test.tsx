import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { Settings } from "./Settings";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
vi.mock("./Channels", () => ({ Channels: () => null }));
vi.mock("./Deliveries", () => ({ Deliveries: () => null }));
vi.mock("./AccountSecurity", () => ({ AccountSecurity: () => null }));
vi.mock("./AllMyThemeControls", () => ({ AllMyThemeControls: () => null }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { vi.mocked(api).mockResolvedValue({}); });
const props = { channels: [], monitors: [], reload: vi.fn(), report: vi.fn(), admin: false, signedOut: vi.fn(), theme: { preference: "system", resolved: "light" } };

it("shows validated build metadata with commit and source PR links", () => {
  render(<Settings {...props} buildMetadata={{
    version: "0.2.0",
    commit: "a".repeat(40),
    branch: "feature/chromium-targeted-optimizations-visual-compare",
    sourcePr: 20,
  }} />);
  expect(screen.getByText("0.2.0", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("feature/chromium-targeted-optimizations-visual-compare", { exact: true })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Commit " + "a".repeat(40) })).toHaveAttribute("href", "https://github.com/mkaand/changd-fusion/commit/" + "a".repeat(40));
  expect(screen.getByRole("link", { name: "#20" })).toHaveAttribute("href", "https://github.com/mkaand/changd-fusion/pull/20");
  const list = screen.getByText("Application").closest(".ant-card")!.querySelector("dl");
  expect(list).toHaveClass("application-metadata-list");
  expect(list?.querySelector("table")).toBeNull();
  expect(list?.querySelectorAll("dt")).toHaveLength(5);
});

it("shows safe fallbacks when deployment metadata is unavailable", () => {
  render(<Settings {...props} buildMetadata={{ version: "0.2.0", commit: "invalid", branch: "bad branch", sourcePr: -1 }} />);
  expect(screen.getByText("0.2.0", { exact: true })).toBeInTheDocument();
  expect(screen.getAllByText("Unavailable", { exact: true })).toHaveLength(3);
  expect(screen.queryByRole("link", { name: /#/ })).not.toBeInTheDocument();
  for (const fallback of screen.getAllByText("Unavailable", { exact: true })) expect(fallback).toHaveClass("application-metadata-token");
});

it("renders authenticated system diagnostics from the API contract", async () => {
  vi.mocked(api).mockImplementation((path: string) => path === "/system/diagnostics"
    ? Promise.resolve({
        api: "ok",
        monitoring: { active: 1, total: 2, attention: 1 },
        deliveries: { pending: 2, failed: 1 },
        retention_days: 90,
      })
    : Promise.resolve({}));
  render(<Settings {...props} />);
  await userEvent.setup().click(screen.getByText("System & Diagnostics", { exact: true }));
  expect(await screen.findByText("1/2 active · 1 need attention")).toBeInTheDocument();
  expect(screen.getByText("2 pending · 1 failed")).toBeInTheDocument();
  expect(screen.getByText("90 days")).toBeInTheDocument();
});

it("renders a safe retryable diagnostics error without leaving the loading indicator stuck", async () => {
  vi.mocked(api).mockImplementation((path: string) => path === "/system/diagnostics" ? Promise.reject(new ApiError("Proxy failure", { status: 502 })) : Promise.resolve({}));
  render(<Settings {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByText("System & Diagnostics", { exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Diagnostics is temporarily unavailable. Retry.");
  expect(screen.queryByRole("status", { name: "Loading diagnostics" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/system/diagnostics")).toHaveLength(2));
});

it("explains a forbidden diagnostics response without exposing an implementation detail", async () => {
  vi.mocked(api).mockImplementation((path: string) => path === "/system/diagnostics" ? Promise.reject(new ApiError("Forbidden upstream body", { status: 403 })) : Promise.resolve({}));
  render(<Settings {...props} />);
  await userEvent.setup().click(screen.getByText("System & Diagnostics", { exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Diagnostics access is not permitted.");
  expect(screen.queryByText("Forbidden upstream body")).not.toBeInTheDocument();
});

it("recovers from a diagnostics timeout without keeping the initial loader visible", async () => {
  vi.mocked(api).mockImplementation((path: string) => path === "/system/diagnostics"
    ? Promise.reject(new DOMException("request timed out", "TimeoutError"))
    : Promise.resolve({}));
  render(<Settings {...props} />);
  await userEvent.setup().click(screen.getByText("System & Diagnostics", { exact: true }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Diagnostics request timed out. Retry.");
  expect(screen.queryByRole("status", { name: "Loading diagnostics" })).not.toBeInTheDocument();
});
