import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FusionApp from "./App";
import { api } from "./api";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
const mockedApi = vi.mocked(api);
const selectedValue = "33.499,00 TL";
const longLine = "A".repeat(220) + selectedValue + "B".repeat(220);
const generatedRule = {
  version: 2 as const,
  kind: "anchored_lines" as const,
  anchors: [{ text: "Product", offset: -2 as const }, { text: "Current price", offset: -1 as const }, { text: "Seller", offset: 1 as const }, { text: "Delivery", offset: 2 as const }],
  prefix: "A".repeat(160),
  suffix: "B".repeat(160),
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
});
