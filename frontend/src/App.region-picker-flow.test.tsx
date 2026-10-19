import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FusionApp from "./App";
import { api } from "./api";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
const mockedApi = vi.mocked(api);
const existing = {
  id: "11111111-1111-4111-8111-111111111111", name: "Existing visual monitor",
  url: "https://example.com/product", kind: "browser", text_enabled: true,
  visual_enabled: true, capture_mode: "element", capture_selector_type: "css",
  capture_selector: "#old-price", interval_seconds: 300, channel_ids: [],
};
const preview = (selector = "#new-price") => ({
  session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=",
  width: 1280, height: 900,
  selection: { selector, x: 10, y: 10, width: 120, height: 30 },
});

function setupApi(detail?: typeof existing, previewFailure = false) {
  mockedApi.mockImplementation(async (path: string, method = "GET", body?: unknown) => {
    if (path === "/users/me") return { id: "user", email: "fixture@example.com" } as never;
    if (path === "/jobs" && method === "GET") return (detail ? [detail] : []) as never;
    if (path === "/notifications") return [{ id: "channel-1", name: "Synthetic channel" }] as never;
    if (path === "/preferences/monitoring") return {} as never;
    if (detail && path === `/jobs/${detail.id}` && method === "GET") return detail as never;
    if (detail && path.startsWith(`/jobs/${detail.id}/history`)) return { items: [], total: 0 } as never;
    if (path === "/region-preview" && method === "POST") {
      if (previewFailure) throw Error("Website preview failed. Retry, or use viewport capture instead.");
      return preview(mockedApi.mock.calls.filter(([calledPath]) => calledPath === "/region-preview").length > 1 ? "#latest-price" : "#new-price") as never;
    }
    if (path.startsWith("/region-preview/") && method === "DELETE") return {} as never;
    if (path === "/jobs" && method === "POST") return { id: "created" } as never;
    if (detail && path === `/jobs/${detail.id}` && method === "PUT") return detail as never;
    throw Error(`Unexpected ${method} ${path} ${JSON.stringify(body)}`);
  });
}

async function openMobileRegion(user: ReturnType<typeof userEvent.setup>, enableVisual = true) {
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  if (enableVisual) await user.click(screen.getByLabelText("Visual detection"));
  await user.click(screen.getByLabelText("Screenshot capture mode"));
  await user.click(screen.getAllByText("Selected element / region", { exact: true }).at(-1)!);
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  vi.mocked(window.matchMedia).mockImplementation((query) => ({ matches: query.includes("max-width"), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
  mockedApi.mockReset();
  setupApi();
});
afterEach(() => { window.history.replaceState({}, "", "/"); cleanup(); vi.clearAllMocks(); });

it("uses the real mobile RegionPicker, preserves unsaved fields, and sends its selected CSS region in an existing-monitor PUT", async () => {
  setupApi(existing);
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "Unsaved renamed monitor" } });
  fireEvent.change(screen.getByLabelText("Check interval (seconds)"), { target: { value: "900" } });
  await openMobileRegion(user, false);
  await user.click(await screen.findByRole("button", { name: "Use selector" }));
  expect(await screen.findByLabelText("Monitor name")).toHaveValue("Unsaved renamed monitor");
  expect(screen.getByLabelText("Check interval (seconds)")).toHaveValue("900");
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(`/jobs/${existing.id}`, "PUT", expect.objectContaining({ name: "Unsaved renamed monitor", interval_seconds: 900, capture_mode: "element", capture_selector_type: "css", capture_selector: "#new-price" })));
  expect(mockedApi.mock.calls.some(([path]) => String(path).endsWith("/reset"))).toBe(false);
}, 20_000);

it("keeps the latest CSS selection across repeated visits and sends a new-monitor POST", async () => {
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await user.click(await screen.findByText("New monitor", { exact: true }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "New visual monitor" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/product" } });
  await openMobileRegion(user);
  await user.click(await screen.findByRole("button", { name: "Use selector" }));
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  await user.click(await screen.findByRole("button", { name: "Use selector" }));
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({ capture_mode: "element", capture_selector_type: "css", capture_selector: "#latest-price" })));
}, 20_000);

it("uses viewport without losing the original draft when the preview cannot be loaded", async () => {
  setupApi(undefined, true);
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await user.click(await screen.findByText("New monitor", { exact: true }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "Viewport monitor" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/product" } });
  await openMobileRegion(user);
  await user.click(await screen.findByRole("button", { name: "Use viewport instead" }));
  expect(await screen.findByLabelText("Monitor name")).toHaveValue("Viewport monitor");
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({ capture_mode: "viewport" })));
}, 20_000);

it("changes an existing monitor to viewport capture without retaining its old region selector", async () => {
  setupApi(existing, true);
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  await openMobileRegion(user, false);
  await user.click(await screen.findByRole("button", { name: "Use viewport instead" }));
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(`/jobs/${existing.id}`, "PUT", expect.objectContaining({ capture_mode: "viewport" })));
  const update = mockedApi.mock.calls.find(([path, method]) => path === `/jobs/${existing.id}` && method === "PUT");
  expect((update?.[2] as { capture_selector?: string }).capture_selector).not.toBe("#old-price");
}, 20_000);

it("returns from RegionPicker without applying a selection and keeps the initial draft", async () => {
  setupApi(existing);
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "Still unsaved" } });
  await openMobileRegion(user, false);
  await user.click(await screen.findByRole("button", { name: "← Back" }));
  expect(await screen.findByLabelText("Monitor name")).toHaveValue("Still unsaved");
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(`/jobs/${existing.id}`, "PUT", expect.objectContaining({ capture_selector: "#old-price" })));
}, 20_000);

it("uses the real mobile SelectedAreaPicker and sends the applied area unchanged in PUT", async () => {
  setupApi(existing);
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "Unsaved area monitor" } });
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Screenshot capture mode"));
  await user.click(screen.getByText("Selected area", { exact: true }));
  await user.click(screen.getByRole("button", { name: "Select area visually" }));
  const image = await screen.findByAltText("Secure selected area preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 10, top: 20, width: 640, height: 450 }) });
  const stage = image.closest(".selected-area-stage")!;
  fireEvent.pointerDown(stage, { pointerId: 10, pointerType: "touch", clientX: 60, clientY: 70 });
  fireEvent.pointerMove(stage, { pointerId: 10, pointerType: "touch", clientX: 220, clientY: 160 });
  fireEvent.pointerUp(stage, { pointerId: 10, pointerType: "touch", clientX: 220, clientY: 160 });
  await user.click(screen.getByRole("button", { name: "Apply selected area" }));
  expect(await screen.findByLabelText("Monitor name")).toHaveValue("Unsaved area monitor");
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(`/jobs/${existing.id}`, "PUT", expect.objectContaining({
    name: "Unsaved area monitor", capture_mode: "selected_area", capture_area: { x: 100, y: 100, width: 320, height: 180 },
  })));
  expect(mockedApi.mock.calls.some(([path]) => String(path).endsWith("/reset"))).toBe(false);
}, 20_000);

it("sends a newly applied selected area in a new-monitor POST while preserving draft fields", async () => {
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await user.click(await screen.findByText("New monitor", { exact: true }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "New selected area" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/new-area" } });
  await user.click(screen.getByRole("switch", { name: "Visual detection" }));
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Screenshot capture mode"));
  await user.click(screen.getByText("Selected area", { exact: true }));
  await user.click(screen.getByRole("button", { name: "Select area visually" }));
  const image = await screen.findByAltText("Secure selected area preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1280, height: 900 }) });
  const stage = image.closest(".selected-area-stage")!;
  fireEvent.pointerDown(stage, { pointerId: 20, pointerType: "mouse", button: 0, clientX: 50, clientY: 60 });
  fireEvent.pointerMove(stage, { pointerId: 20, pointerType: "mouse", clientX: 250, clientY: 160 });
  fireEvent.pointerUp(stage, { pointerId: 20, pointerType: "mouse", clientX: 250, clientY: 160 });
  await user.click(screen.getByRole("button", { name: "Apply selected area" }));
  expect(await screen.findByLabelText("Monitor name")).toHaveValue("New selected area");
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({
    name: "New selected area", url: "https://example.com/new-area", capture_mode: "selected_area", capture_area: { x: 50, y: 60, width: 200, height: 100 },
  })));
}, 20_000);
