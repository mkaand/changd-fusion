import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { Settings } from "./Settings";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
vi.mock("./Channels", () => ({ Channels: () => null }));
vi.mock("./Deliveries", () => ({ Deliveries: () => null }));
vi.mock("./AccountSecurity", () => ({ AccountSecurity: () => null }));
vi.mock("./AllMyThemeControls", () => ({ AllMyThemeControls: () => null }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const props = { channels: [], monitors: [], reload: vi.fn(), report: vi.fn(), admin: false, signedOut: vi.fn(), theme: { preference: "system", resolved: "light" } };

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
