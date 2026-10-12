import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { TextPicker } from "./TextPicker";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows safe Reader text and applies a server-validated contextual rule", async () => {
  const rule = { version: 1 as const, kind: "bounded_context" as const, before: "Price\n", after: "\nSeller", max_length: 64 };
  vi.mocked(api).mockResolvedValueOnce({ session_id: "session", items: [{ index: 0, text: "Product" }, { index: 1, text: "32.999,00 TL" }, { index: 2, text: "Seller" }], matching_line_count: 3, total_line_count: 3 }).mockResolvedValueOnce({ session_id: "session", rule, extracted: "32.999,00 TL", description: "Text between context" });
  const apply = vi.fn();
  render(<TextPicker getDraft={() => ({ url: "https://example.com", text_source: "jina" })} onApply={apply} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select text from preview" }));
  await user.click(await screen.findByText("32.999,00 TL"));
  await user.click(screen.getByRole("button", { name: "Generate extraction rule" }));
  expect(await screen.findByText("Text between context")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply selection" }));
  expect(apply).toHaveBeenCalledWith(rule);
  await waitFor(() => expect(api).toHaveBeenLastCalledWith("/text-preview", "POST", { session_id: "session", line_index: 1, selected_value: "32.999,00 TL" }));
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
  expect(await screen.findByText("1 matching line in 2101 available Reader lines")).toBeInTheDocument();
  expect(screen.getByRole("listitem")).toHaveTextContent("İstanbul teslimat");
  await user.click(screen.getByRole("listitem"));
  await user.click(screen.getByRole("button", { name: "Generate extraction rule" }));
  await waitFor(() => expect(api).toHaveBeenLastCalledWith("/text-preview", "POST", { session_id: "session", line_index: 2_050, selected_value: "İstanbul teslimat" }));
});
