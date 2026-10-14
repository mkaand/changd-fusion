import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, expect, it, vi } from "vitest";
import { AccountSecurity } from "./AccountSecurity";
import { api } from "./api";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
const mockedApi = vi.mocked(api);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function openVerified(initial: boolean, put?: (enabled: boolean) => Promise<{ enabled: boolean }>) {
  mockedApi.mockImplementation(async (path: string, method = "GET", body?: any) => {
    if (path === "/security/verify") return { ok: true } as any;
    if (path === "/security/leave") return { ok: true } as any;
    if (path === "/account/public-access" && method === "GET") return { public_enabled: initial } as any;
    if (path === "/account/public-access" && method === "PUT") return await (put?.(body.enabled) ?? Promise.resolve({ enabled: body.enabled })) as any;
    throw Error(`Unexpected ${method} ${path}`);
  });
  const user = userEvent.setup();
  render(<AntApp><AccountSecurity signedOut={vi.fn()} /></AntApp>);
  await user.click(screen.getByRole("button", { name: "Account security" }));
  await user.type(screen.getByLabelText("Email"), "owner@example.com");
  await user.type(screen.getByLabelText("Password"), "synthetic-owner-password");
  await user.click(screen.getByRole("button", { name: "Verify account" }));
  await screen.findByRole("region", { name: "Public Access setting" });
  await waitFor(() => expect(screen.getByRole("button", { name: initial ? "Disable public access" : "Enable public access" })).toBeEnabled());
  return user;
}

it.each([[false, true, "Enable public access?", "Enable public access"], [true, false, "Disable public access?", "Disable public access"]] as const)("confirms a server-backed transition from %s to %s", async (initial, desired, title, action) => {
  const user = await openVerified(initial);
  fireEvent.click(screen.getByRole("button", { name: action }));
  expect((await screen.findByText(title)).closest(".ant-modal")).not.toBeNull();
  await user.click(screen.getAllByRole("button", { name: action }).at(-1)!);
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/account/public-access", "PUT", { enabled: desired, confirm: true }));
  expect(await screen.findByText(desired ? "Enabled" : "Disabled")).toBeInTheDocument();
});

it.each([false, true])("cancels a pending transition without changing persisted state (%s)", async (initial) => {
  const user = await openVerified(initial);
  fireEvent.click(screen.getByRole("button", { name: initial ? "Disable public access" : "Enable public access" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mockedApi.mock.calls.some(([path, method]) => path === "/account/public-access" && method === "PUT")).toBe(false);
  expect(screen.getByText(initial ? "Enabled" : "Disabled")).toBeInTheDocument();
});

it.each([false, true])("keeps the last persisted state when a transition from %s fails", async (initial) => {
  const user = await openVerified(initial, async () => { throw Error("Public Access update failed"); });
  const action = initial ? "Disable public access" : "Enable public access";
  fireEvent.click(screen.getByRole("button", { name: action }));
  await user.click(screen.getAllByRole("button", { name: action }).at(-1)!);
  expect(await screen.findAllByText("Public Access update failed")).not.toHaveLength(0);
  expect(screen.getByText(initial ? "Enabled" : "Disabled")).toBeInTheDocument();
});

it("uses a bounded mobile modal with complete accessible actions", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  const user = await openVerified(false);
  fireEvent.click(screen.getByRole("button", { name: "Enable public access" }));
  await screen.findByText("Enable public access?");
  const title = screen.getAllByText("Enable public access?").at(-1)!;
  const modal = title.closest(".ant-modal")!;
  expect(title.closest(".public-access-confirmation")).not.toBeNull();
  expect(within(modal as HTMLElement).getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(within(modal as HTMLElement).getByRole("button", { name: "Enable public access" })).toBeEnabled();
  expect(modal).toHaveTextContent("monitor and notification configuration");
});

it("prevents duplicate Public Access submissions", async () => {
  let release!: (value: { enabled: boolean }) => void;
  const pending = new Promise<{ enabled: boolean }>((resolve) => { release = resolve; });
  const user = await openVerified(false, () => pending);
  fireEvent.click(screen.getByRole("button", { name: "Enable public access" }));
  const confirm = screen.getAllByRole("button", { name: "Enable public access" }).at(-1)!;
  await user.dblClick(confirm);
  expect(mockedApi.mock.calls.filter(([path, method]) => path === "/account/public-access" && method === "PUT")).toHaveLength(1);
  release({ enabled: true });
  await screen.findByText("Enabled");
});

it("reloads the persisted Public Access state after Account Security is reopened", async () => {
  let reads = 0;
  mockedApi.mockImplementation(async (path: string, method = "GET") => {
    if (path === "/security/verify") return { ok: true } as any;
    if (path === "/security/leave") return { ok: true } as any;
    if (path === "/account/public-access" && method === "GET") return { public_enabled: reads++ > 0 } as any;
    throw Error(`Unexpected ${method} ${path}`);
  });
  const user = userEvent.setup();
  render(<AntApp><AccountSecurity signedOut={vi.fn()} /></AntApp>);
  const verify = async () => {
    await user.click(screen.getByRole("button", { name: "Account security" }));
    await user.type(screen.getByLabelText("Email"), "owner@example.com");
    await user.type(screen.getByLabelText("Password"), "synthetic-owner-password");
    await user.click(screen.getByRole("button", { name: "Verify account" }));
    await screen.findByRole("region", { name: "Public Access setting" });
    await waitFor(() => expect(screen.getByRole("button", { name: reads > 1 ? "Disable public access" : "Enable public access" })).toBeEnabled());
  };
  await verify();
  expect(await screen.findByText("Disabled")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/security/leave", "POST", {}));
  await verify();
  expect(await screen.findByText("Enabled")).toBeInTheDocument();
  expect(reads).toBe(2);
});
