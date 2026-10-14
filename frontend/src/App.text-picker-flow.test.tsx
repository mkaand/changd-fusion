import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FusionApp from "./App";
import { api } from "./api";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
const mockedApi = vi.mocked(api);
const selectedValue = "33.499,00 TL";
const longPrefix = "A".repeat(205) + "unique-prefix-";
const longSuffix = "-unique-suffix" + "B".repeat(205);
const longLine = longPrefix + selectedValue + longSuffix;
const generatedRule = {
  version: 2 as const,
  kind: "anchored_lines" as const,
  anchors: [{ text: "Product", offset: -2 as const }, { text: "Current price", offset: -1 as const }, { text: "Seller", offset: 1 as const }, { text: "Delivery", offset: 2 as const }],
  prefix: longPrefix.slice(-160),
  suffix: longSuffix.slice(0, 160),
  max_length: 64,
};

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  vi.mocked(window.matchMedia).mockImplementation((query) => ({ matches: query.includes("max-width"), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
  mockedApi.mockImplementation(async (path: string, method = "GET", body?: any) => {
    if (path === "/users/me") return { id: "user", email: "fixture@example.com" } as any;
    if (path === "/jobs" && method === "GET") return [] as any;
    if (path === "/notifications") return [] as any;
    if (path === "/preferences/monitoring") return {} as any;
    if (path === "/text-preview" && body?.line_index !== undefined) return { session_id: "preview-session", rule: generatedRule, extracted: selectedValue, description: "Text anchored by surrounding product lines" } as any;
    if (path === "/text-preview") return { session_id: "preview-session", items: [{ index: 0, text: "Product" }, { index: 1, text: "Current price" }, { index: 2, text: longLine }, { index: 3, text: "Seller" }, { index: 4, text: "Delivery" }], matching_line_count: 5, total_line_count: 5 } as any;
    if (path === "/jobs" && method === "POST") return { id: "created" } as any;
    throw Error(`Unexpected ${method} ${path}`);
  });
});
afterEach(() => { window.history.replaceState({}, "", "/"); cleanup(); vi.clearAllMocks(); });

it("uses the real mobile TextPicker and preserves the draft through apply, remount, and save", async () => {
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "GET", undefined, expect.anything()));
  await user.click(screen.getByText("New monitor", { exact: true }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "Unsaved mobile monitor" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/product" } });
  fireEvent.change(screen.getByLabelText("Check interval (seconds)"), { target: { value: "900" } });
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/, { exact: false }));
  await user.click(screen.getByLabelText("Extraction mode"));
  await user.click(screen.getByText("Selected Text / Value", { exact: true }));
  await user.click(screen.getByRole("button", { name: "Select text from preview" }));
  const target = (await screen.findAllByRole("listitem")).find((item) => item.textContent === longLine);
  expect(target).toBeDefined();
  await user.click(target!);
  fireEvent.change(document.querySelector(".text-picker-selection textarea")!, { target: { value: selectedValue } });
  await user.click(screen.getByRole("button", { name: "Generate extraction rule" }));
  await user.click(await screen.findByRole("button", { name: "Apply selection to editor" }));
  expect(await screen.findByLabelText("Monitor name")).toHaveValue("Unsaved mobile monitor");
  expect(screen.getByLabelText("Check interval (seconds)")).toHaveValue("900");
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({ name: "Unsaved mobile monitor", interval_seconds: 900, text_source: "jina", extraction_mode: "selected_text", extraction_rule: generatedRule })));
  expect(mockedApi.mock.calls.some(([path]) => String(path).endsWith("/reset"))).toBe(false);
}, 20_000);

it("returns from the real mobile TextPicker Back action without merging its click event into the editor draft", async () => {
  const existingRule = {
    version: 2 as const,
    kind: "anchored_lines" as const,
    anchors: [{ text: "Product", offset: -2 as const }, { text: "Price", offset: -1 as const }, { text: "Seller", offset: 1 as const }],
    prefix: "", suffix: "", max_length: 64,
  };
  const existing = {
    id: "11111111-1111-4111-8111-111111111111", name: "Existing Reader monitor",
    url: "https://example.com/product", kind: "browser", text_enabled: true, visual_enabled: false,
    text_source: "jina", extraction_mode: "selected_text", extraction_rule: existingRule,
    interval_seconds: 300, channel_ids: [],
  };
  mockedApi.mockImplementation(async (path: string, method = "GET", body?: any) => {
    if (path === "/users/me") return { id: "user", email: "fixture@example.com" } as any;
    if (path === "/jobs" && method === "GET") return [existing] as any;
    if (path === "/notifications") return [] as any;
    if (path === `/jobs/${existing.id}` && method === "GET") return existing as any;
    if (path.startsWith(`/jobs/${existing.id}/history`)) return { items: [], total: 0 } as any;
    if (path === "/text-preview") return { session_id: "preview-session", items: [{ index: 0, text: "Product" }, { index: 1, text: "Price" }, { index: 2, text: "33.499,00 TL" }, { index: 3, text: "Seller" }], matching_line_count: 4, total_line_count: 4 } as any;
    if (path === `/jobs/${existing.id}` && method === "PUT") return existing as any;
    throw Error(`Unexpected ${method} ${path} ${JSON.stringify(body)}`);
  });
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await user.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "Unsaved Reader monitor" } });
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByRole("button", { name: "Select text from preview" }));
  await user.click(await screen.findByRole("button", { name: "← Back" }));
  expect(await screen.findByLabelText("Monitor name")).toHaveValue("Unsaved Reader monitor");
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(`/jobs/${existing.id}`, "PUT", expect.objectContaining({ name: "Unsaved Reader monitor", extraction_rule: existingRule })));
  const payload = mockedApi.mock.calls.find(([path, method]) => path === `/jobs/${existing.id}` && method === "PUT")?.[2] as Record<string, unknown>;
  expect(payload).not.toHaveProperty("nativeEvent");
  expect(payload).not.toHaveProperty("isDefaultPrevented");
}, 20_000);
