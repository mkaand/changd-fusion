import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { TextPicker } from "./TextPicker";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("recovers from HTTP 410 with the search query while discarding stale selections", async () => {
  let fresh = false;
  vi.mocked(api).mockImplementation(async (_path, _method, body: any) => {
    if (body?.session_id && body?.query !== undefined) throw new ApiError("expired", { status: 410 });
    if (body?.session_id && body?.line_index !== undefined) throw new ApiError("expired", { status: 410 });
    if (body?.query === "f") { fresh = true; return { session_id: "fresh", items: [{ index: 1, text: "Fresh price" }], matching_line_count: 1, total_line_count: 3 }; }
    return { session_id: "old", items: [{ index: 1, text: "Old price" }], matching_line_count: 1, total_line_count: 3 };
  });
  const apply = vi.fn();
  render(<TextPicker getDraft={() => ({ url: "https://example.com", text_source: "direct" })} onApply={apply} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select text from preview" }));
  await user.click(await screen.findByText("Old price"));
  await user.type(screen.getByRole("searchbox", { name: "Search extracted output" }), "f");
  expect(await screen.findByText(/Text preview expired\. Refresh to search/)).toBeInTheDocument();
  expect(screen.queryByText("Old price")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply selection to editor" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Refresh preview" }));
  await waitFor(() => expect(screen.getByRole("listitem")).toHaveTextContent("Fresh price"));
  expect(fresh).toBe(true);
  expect(screen.getByRole("searchbox", { name: "Search extracted output" })).toHaveValue("f");
  expect(apply).not.toHaveBeenCalled();
});

it("shows actionable HTTP 422 ambiguity without applying a rule", async () => {
  vi.mocked(api).mockResolvedValueOnce({ session_id: "session", items: [{ index: 0, text: "34.819,01 ₺" }], matching_line_count: 1, total_line_count: 1 })
    .mockRejectedValueOnce(new ApiError("The selected occurrence cannot be distinguished safely. Select a value with unique nearby context.", { status: 422 }));
  const apply = vi.fn();
  render(<TextPicker getDraft={() => ({ url: "https://example.com", text_source: "markdown_new" })} onApply={apply} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select text from preview" }));
  await user.click(await screen.findByText("34.819,01 ₺"));
  await user.click(screen.getByRole("button", { name: "Generate extraction rule" }));
  expect(await screen.findByText(/cannot be distinguished safely/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply selection to editor" })).not.toBeInTheDocument();
  expect(apply).not.toHaveBeenCalled();
});

it.each([
  ["direct", undefined],
  ["jina", undefined],
  ["markdown_new", "auto"],
  ["markdown_new", "browser"],
])("previews the configured %s source and rendering %s", async (text_source, markdown_render) => {
  vi.mocked(api).mockResolvedValue({ session_id: "session", items: [{ index: 0, text: "Product" }], matching_line_count: 1, total_line_count: 1 });
  const draft = { url: "https://example.com", text_source, markdown_render, browser_steps: [] };
  render(<TextPicker getDraft={() => draft} onApply={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Select text from preview" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/text-preview", "POST", expect.objectContaining({ text_source, markdown_render, monitor: draft }), expect.anything()));
});

it("shows safe Reader text and applies a server-validated contextual rule", async () => {
  const rule = { version: 2 as const, kind: "anchored_lines" as const, anchors: [{ text: "Product", offset: -1 as const }, { text: "Seller", offset: 1 as const }], prefix: "", suffix: "", max_length: 64 };
  vi.mocked(api).mockResolvedValueOnce({ session_id: "session", items: [{ index: 0, text: "Product" }, { index: 1, text: "32.999,00 TL" }, { index: 2, text: "Seller" }], matching_line_count: 3, total_line_count: 3 }).mockResolvedValueOnce({ session_id: "session", rule, extracted: "32.999,00 TL", description: "Text between context" });
  const apply = vi.fn();
  render(<TextPicker getDraft={() => ({ url: "https://example.com", text_source: "jina" })} onApply={apply} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select text from preview" }));
  await user.click(await screen.findByText("32.999,00 TL"));
  await user.click(screen.getByRole("button", { name: "Generate extraction rule" }));
  expect(await screen.findByText("Text between context")).toBeInTheDocument();
  expect(screen.getByText("The monitor is not saved until you return to the editor and choose Save monitor.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply selection to editor" }));
  expect(apply).toHaveBeenCalledWith(rule);
  await waitFor(() => expect(api).toHaveBeenLastCalledWith("/text-preview", "POST", { session_id: "session", line_index: 1, selected_value: "32.999,00 TL" }, { signal: expect.any(AbortSignal) }));
});

it("rejects a malformed generated rule with actionable feedback", async () => {
  vi.mocked(api).mockResolvedValueOnce({ session_id: "session", items: [{ index: 0, text: "Product" }, { index: 1, text: "Value" }, { index: 2, text: "Seller" }], matching_line_count: 3, total_line_count: 3 }).mockResolvedValueOnce({ session_id: "session", rule: { version: 2, kind: "anchored_lines", anchors: [{ text: "Product", offset: -1 }], prefix: "", suffix: "", max_length: 64 }, extracted: "Value" });
  render(<TextPicker getDraft={() => ({ url: "https://example.com", text_source: "jina" })} onApply={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select text from preview" }));
  await user.click(await screen.findByText("Value"));
  await user.click(screen.getByRole("button", { name: "Generate extraction rule" }));
  expect(await screen.findByText("The generated extraction rule is invalid. Refresh the preview and try again.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply selection to editor" })).not.toBeInTheDocument();
});

it("searches Turkish Reader text immediately while preserving original line indexes", async () => {
  vi.mocked(api).mockImplementation(async (_path, _method, body: any) => {
    if (body?.query !== undefined) return { session_id: "session", items: [{ index: 2_050, text: "İstanbul teslimat" }], matching_line_count: 1, total_line_count: 2_101 };
    if (body?.line_index !== undefined) return { session_id: "session", rule: { version: 1, kind: "bounded_context", before: "", after: "next", max_length: 64 }, extracted: "İstanbul teslimat", description: "Text between context" };
    return { session_id: "session", items: [{ index: 0, text: "İşlemci: Intel N150" }, { index: 1, text: "Stokta yok" }, { index: 2_050, text: "İstanbul teslimat" }], matching_line_count: 3, total_line_count: 2_101 };
  });
  render(<TextPicker getDraft={() => ({ url: "https://example.com", text_source: "jina" })} onApply={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select text from preview" }));
  const search = await screen.findByRole("searchbox", { name: "Search Reader output" });
  await user.type(search, "istanbul");
  expect(await screen.findByText("1 matching line in 2101 available Reader segments")).toBeInTheDocument();
  expect(screen.getByRole("listitem")).toHaveTextContent("İstanbul teslimat");
  await user.click(screen.getByRole("listitem"));
  await user.click(screen.getByRole("button", { name: "Generate extraction rule" }));
  await waitFor(() => expect(api).toHaveBeenLastCalledWith("/text-preview", "POST", { session_id: "session", line_index: 2_050, selected_value: "İstanbul teslimat" }, { signal: expect.any(AbortSignal) }));
});
