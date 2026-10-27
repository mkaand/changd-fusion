import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { RegionPicker } from "./RegionPicker";

vi.mock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  api: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const draft = {
  url: "https://fixture.example/products",
  kind: "browser",
  visual_enabled: true,
  browser_steps: [],
  capture_timeout_ms: 90_000,
};

it("uses unsaved draft monitor settings without persisting them", async () => {
  vi.mocked(api).mockResolvedValue({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 1280, height: 900, selection: null });
  render(<RegionPicker getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Select region visually" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(
    "/region-preview",
    "POST",
    expect.objectContaining({ session_id: undefined, monitor_id: undefined, monitor: { ...draft, step_budget_ms: 20_000, capture_timeout_ms: 90_000 }, point: undefined, preview_request_id: expect.any(String) }),
    expect.objectContaining({ timeoutMs: 125000 }),
  ));
  expect(screen.getByAltText("Secure monitor preview")).toBeInTheDocument();
});

it("zooms without selecting and maps a click to original preview coordinates", async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 1280, height: 900, selection: null })
    .mockResolvedValueOnce({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 1280, height: 900, selection: { selector: "#price", x: 100, y: 100, width: 200, height: 50 } });
  render(<RegionPicker getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  await screen.findByAltText("Secure monitor preview");
  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.getByLabelText("Current zoom")).toHaveTextContent("125%");
  expect(api).toHaveBeenCalledTimes(1);
  const image = screen.getByAltText("Secure monitor preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 10, top: 20, width: 640, height: 450 }) });
  fireEvent.pointerDown(image, { pointerId: 1, clientX: 330, clientY: 245 });
  fireEvent.pointerUp(image, { pointerId: 1, clientX: 330, clientY: 245 });
  await waitFor(() => expect(api).toHaveBeenLastCalledWith(
    "/region-preview",
    "POST",
    expect.objectContaining({ session_id: "00000000-0000-4000-8000-000000000099", point: { x: 640, y: 450 } }),
    expect.objectContaining({ timeoutMs: 125000 }),
  ));
});

it("maps mobile preview taps against the returned 390 by 844 viewport", async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 390, height: 844, selection: null })
    .mockResolvedValueOnce({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 390, height: 844, selection: { selector: "#mobile", x: 195, y: 422, width: 40, height: 40 } });
  render(<RegionPicker mobilePage getDraft={() => ({ ...draft, mobile_view: true })} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  const image = await screen.findByAltText("Secure monitor preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 10, top: 20, width: 195, height: 422 }) });
  fireEvent.pointerDown(image, { pointerId: 12, pointerType: "touch", clientX: 107.5, clientY: 231 });
  fireEvent.pointerUp(image.closest(".region-preview-canvas")!, { pointerId: 12, pointerType: "touch", clientX: 107.5, clientY: 231 });
  await waitFor(() => expect(api).toHaveBeenLastCalledWith(
    "/region-preview",
    "POST",
    expect.objectContaining({ point: { x: 195, y: 422 } }),
    expect.anything(),
  ));
});

it("builds a CSS browser step from Preview without enabling visual detection", async () => {
  const onAddStep = vi.fn();
  vi.mocked(api).mockResolvedValue({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 1280, height: 900, http_status: 403, selection: { selector: "#reject-cookies", label: "Exact: button", x: 20, y: 20, width: 120, height: 44 } });
  render(<RegionPicker purpose="step" getDraft={() => ({ ...draft, visual_enabled: false })} onAddStep={onAddStep} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add step from Preview" }));
  expect(await screen.findByText("HTTP 403 error page")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Optional browser step" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Add step to draft" }));
  expect(onAddStep).toHaveBeenCalledWith({ action: "click", selector: "#reject-cookies", selector_type: "css", timeout_ms: 5000, continue_on_error: false });
  expect(screen.getByText("Step added to the unsaved draft")).toBeInTheDocument();
});

it("does not select while panning, after pointer cancellation, or twice while a selection is pending", async () => {
  let resolveSelection!: (value: unknown) => void;
  vi.mocked(api)
    .mockResolvedValueOnce({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 1280, height: 900, selection: null })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveSelection = resolve; }));
  render(<RegionPicker getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  const image = await screen.findByAltText("Secure monitor preview");
  const canvas = image.closest(".region-preview-canvas")!;
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 10, top: 20, width: 640, height: 450 }) });
  await user.click(screen.getByRole("button", { name: "Zoom in" }));

  fireEvent.pointerDown(image, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300, clientY: 220 });
  fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: 340, clientY: 260 });
  fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "mouse", clientX: 340, clientY: 260 });
  fireEvent.pointerDown(image, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 220 });
  fireEvent.pointerCancel(canvas, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 220 });
  expect(api).toHaveBeenCalledTimes(1);

  fireEvent.pointerDown(image, { pointerId: 3, pointerType: "mouse", button: 0, clientX: 330, clientY: 245 });
  fireEvent.pointerUp(canvas, { pointerId: 3, pointerType: "mouse", clientX: 330, clientY: 245 });
  fireEvent.pointerDown(image, { pointerId: 4, pointerType: "mouse", button: 0, clientX: 330, clientY: 245 });
  fireEvent.pointerUp(canvas, { pointerId: 4, pointerType: "mouse", clientX: 330, clientY: 245 });
  expect(api).toHaveBeenCalledTimes(2);
  resolveSelection({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 1280, height: 900, selection: null });
  await waitFor(() => expect(screen.queryByLabelText("Resolving selected region")).not.toBeInTheDocument());
});

it("keeps the form usable after a safe preview error and offers retry and viewport fallback", async () => {
  const requestId = `safe-${"request-id-".repeat(18)}`;
  const retry = new ApiError("Preview timed out. Retry, or use viewport capture instead.", {
    request_id: requestId,
    preview_stage: "navigation",
    failure_code: "timeout",
  });
  vi.mocked(api).mockRejectedValue(retry);
  const viewport = vi.fn();
  render(<RegionPicker monitorId="00000000-0000-4000-8000-000000000001" getDraft={() => draft} onSelect={vi.fn()} onUseViewport={viewport} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Preview timed out");
  expect(screen.getByRole("alert")).toHaveTextContent("navigation · timeout");
  expect(screen.getByRole("alert")).toHaveTextContent(`Request ID: ${requestId}`);
  await user.click(screen.getByRole("button", { name: "Refresh preview" }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert")).toHaveTextContent("Preview timed out");
  await user.click(screen.getByRole("button", { name: "Use viewport instead" }));
  expect(viewport).toHaveBeenCalledOnce();
});

it("refreshes a stale selection inside the existing session and clears the old error while loading", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000099";
  let resolveRefresh!: (value: unknown) => void;
  vi.mocked(api)
    .mockResolvedValueOnce({ session_id: sessionId, image: "aGVsbG8=", width: 1280, height: 900, selection: null })
    .mockRejectedValueOnce(new ApiError("The page changed after the screenshot.", { status: 409, failure_code: "stale_preview", preview_stage: "text_extraction" }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  render(<RegionPicker getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  const image = await screen.findByAltText("Secure monitor preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1280, height: 900 }) });
  fireEvent.pointerDown(image, { pointerId: 7, pointerType: "mouse", button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(image.closest(".region-preview-canvas")!, { pointerId: 7, pointerType: "mouse", clientX: 100, clientY: 100 });
  expect(await screen.findByRole("alert")).toHaveTextContent("stale_preview");
  await user.click(screen.getByRole("button", { name: "Retry selection" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(api).toHaveBeenLastCalledWith("/region-preview", "POST", expect.objectContaining({ session_id: sessionId, point: { x: 100, y: 100 }, refresh: true }), expect.objectContaining({ timeoutMs: 125000 }));
  resolveRefresh({ session_id: sessionId, image: "aGVsbG8=", width: 1280, height: 900, selection: { selector: "#target", x: 90, y: 90, width: 20, height: 20 } });
  expect(await screen.findByText("Selected visible element")).toBeInTheDocument();
});

it("mobile Back cancels pending Preview and ignores a late owner session", async () => {
  let finish!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation((path, method, _data, options) => {
    if (method === "DELETE") return Promise.resolve({}) as any;
    if (path === "/region-preview") { signal = options?.signal; return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve({ stage: "capacity_wait" }) as any;
  });
  const back = vi.fn();
  const { unmount } = render(<RegionPicker mobilePage getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} onBackMobile={back} />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  await userEvent.click(screen.getByRole("button", { name: "← Back" }));
  expect(back).toHaveBeenCalled();
  expect(signal?.aborted).toBe(true);
  const id = "00000000-0000-4000-8000-000000000088";
  finish({ session_id: id, image: "aGVsbG8=", width: 1280, height: 900 });
  await waitFor(() => expect(api).toHaveBeenCalledWith(`/region-preview/${id}`, "DELETE"));
  expect(screen.queryByText("Selected visible element")).not.toBeInTheDocument();
  unmount();
});

it("cannot apply a selector from a Preview rendered before manual draft edits", async () => {
  const current = { ...draft };
  const select = vi.fn();
  const id = "00000000-0000-4000-8000-000000000077";
  vi.mocked(api).mockResolvedValue({ session_id: id, image: "aGVsbG8=", width: 1280, height: 900, selection: { selector: "#old-target", x: 0, y: 0, width: 30, height: 30 } });
  render(<RegionPicker getDraft={() => current} onSelect={select} onUseViewport={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  await screen.findByText("Selected visible element");
  current.url = "https://changed-fixture.example";
  await user.click(screen.getByRole("button", { name: "Use selector" }));
  expect(select).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Preview settings changed");
  await waitFor(() => expect(api).toHaveBeenCalledWith(`/region-preview/${id}`, "DELETE"));
});

it("does not open a network preview when the visual draft is incomplete", async () => {
  render(<RegionPicker getDraft={() => ({ kind: "browser", visual_enabled: false })} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Select region visually" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid Browser URL");
  expect(api).not.toHaveBeenCalled();
});

it("releases the owner-bound preview session on close, viewport fallback, selector use, and unmount", async () => {
  const sessionId = "00000000-0000-4000-8000-000000000099";
  vi.mocked(api).mockResolvedValue({ session_id: sessionId, image: "aGVsbG8=", width: 1280, height: 900, selection: { selector: "#target", x: 10, y: 10, width: 20, height: 20 } });
  const first = render(<RegionPicker getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  await screen.findByText("Selected visible element");
  await user.click(screen.getByRole("button", { name: "Use selector" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(`/region-preview/${sessionId}`, "DELETE"));
  first.unmount();

  vi.clearAllMocks();
  vi.mocked(api).mockResolvedValue({ session_id: sessionId, image: "aGVsbG8=", width: 1280, height: 900, selection: null });
  const second = render(<RegionPicker getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  await screen.findByAltText("Secure monitor preview");
  await user.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(`/region-preview/${sessionId}`, "DELETE"));
  second.unmount();
});
