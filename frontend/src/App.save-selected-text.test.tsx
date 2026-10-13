import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { App as AntApp } from "antd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import FusionApp from "./App";
import { api } from "./api";
vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
vi.mock("./TextPicker", () => ({
  TextPicker: ({ onApply, onRequestMobile, mobilePage }: { onApply: (value: unknown) => void; onRequestMobile?: () => void; mobilePage?: boolean }) => mobilePage
    ? <button type="button" onClick={() => onApply({ version: 1, kind: "bounded_context", before: "Fiyat\n", after: "\nSatıcı", max_length: 64 })}>Apply fixture selection</button>
    : <button type="button" onClick={() => window.innerWidth < 1024 && onRequestMobile ? onRequestMobile() : onApply({ version: 1, kind: "bounded_context", before: "Fiyat\n", after: "\nSatıcı", max_length: 64 })}>{window.innerWidth < 1024 && onRequestMobile ? "Open fixture text picker" : "Apply fixture selection"}</button>,
}));
const mockedApi = vi.mocked(api);
const rule = { version: 1, kind: "bounded_context", before: "Fiyat\n", after: "\nSatıcı", max_length: 64 } as const;
function setupApi(monitors: any[] = [], detail?: any) { mockedApi.mockImplementation(async (path: string, method = "GET", data?: any) => {
  if (path === "/users/me") return { id: "user", email: "fixture@example.com" } as any;
  if (path === "/jobs" && method === "GET") return monitors as any;
  if (path === "/notifications") return [] as any;
  if (path === "/preferences/monitoring") return {} as any;
  if (detail && path === `/jobs/${detail.id}` && method === "GET") return detail as any;
  if (path === "/jobs" && method === "POST") return { id: "created" } as any;
  if (detail && path === `/jobs/${detail.id}` && method === "PUT") return detail as any;
  throw Error(`Unexpected ${method} ${path}`);
}); }
beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 }); mockedApi.mockReset(); setupApi(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("sends the applied Selected Text rule through the real Save monitor API call", async () => {
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "GET", undefined, expect.anything()));
  await user.click(screen.getByText("New monitor", { exact: true }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "Price monitor" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/product" } });
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/, { exact: false }));
  await user.click(await screen.findByLabelText("Extraction mode"));
  await user.click(screen.getByText("Selected Text / Value", { exact: true }));
  await user.click(screen.getByRole("button", { name: "Apply fixture selection" }));
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({ text_source: "jina", extraction_mode: "selected_text", extraction_rule: rule })));
});
it("sends the applied Selected Text rule through the real existing-monitor PUT call", async () => {
  const existing = { id: "11111111-1111-4111-8111-111111111111", name: "Existing price", url: "https://example.com/product", kind: "browser", text_enabled: true, visual_enabled: false, text_source: "jina", extraction_mode: "selected_text", extraction_rule: rule, interval_seconds: 300, channel_ids: [] };
  setupApi([existing], existing);
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await screen.findByLabelText("Actions for Existing price");
  await user.click(screen.getByLabelText("Actions for Existing price"));
  await user.click(await screen.findByText("Edit", { exact: true }));
  await screen.findByLabelText("Monitor name");
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByRole("button", { name: "Apply fixture selection" }));
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(`/jobs/${existing.id}`, "PUT", expect.objectContaining({ text_source: "jina", extraction_mode: "selected_text", extraction_rule: rule })));
});
it("keeps a mobile Text Picker selection through return to the editor and the Save monitor POST call", async () => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  vi.mocked(window.matchMedia).mockImplementation((query) => ({ matches: query === "(max-width: 1023px)", media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
  const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });
  render(<AntApp><FusionApp /></AntApp>);
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "GET", undefined, expect.anything()));
  await user.click(screen.getByText("New monitor", { exact: true }));
  fireEvent.change(screen.getByLabelText("Monitor name"), { target: { value: "Mobile price monitor" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/product" } });
  await user.click(screen.getByText("Advanced settings", { exact: true }));
  await user.click(screen.getByLabelText("Text content source"));
  await user.click(screen.getByText(/Jina Reader —/, { exact: false }));
  await user.click(await screen.findByLabelText("Extraction mode"));
  await user.click(screen.getByText("Selected Text / Value", { exact: true }));
  await user.click(screen.getByRole("button", { name: "Open fixture text picker" }));
  await user.click(await screen.findByRole("button", { name: "Apply fixture selection" }));
  await user.click(screen.getByRole("button", { name: "Save monitor" }));
  await waitFor(() => expect(mockedApi).toHaveBeenCalledWith("/jobs", "POST", expect.objectContaining({ text_source: "jina", extraction_mode: "selected_text", extraction_rule: rule })));
});
