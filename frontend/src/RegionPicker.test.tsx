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
};

it("uses unsaved draft monitor settings without persisting them", async () => {
  vi.mocked(api).mockResolvedValue({ session_id: "00000000-0000-4000-8000-000000000099", image: "aGVsbG8=", width: 1280, height: 900, selection: null });
  render(<RegionPicker getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Select region visually" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(
    "/region-preview",
    "POST",
    expect.objectContaining({ session_id: undefined, monitor_id: undefined, monitor: { ...draft }, point: undefined, preview_request_id: expect.any(String) }),
    { timeoutMs: 125000 },
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
    { timeoutMs: 125000 },
  ));
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
  expect(api).toHaveBeenLastCalledWith("/region-preview", "POST", expect.objectContaining({ session_id: sessionId, point: { x: 100, y: 100 }, refresh: true }), { timeoutMs: 125000 });
  resolveRefresh({ session_id: sessionId, image: "aGVsbG8=", width: 1280, height: 900, selection: { selector: "#target", x: 90, y: 90, width: 20, height: 20 } });
  expect(await screen.findByText("Selected visible element")).toBeInTheDocument();
});

it("does not open a network preview when the visual draft is incomplete", async () => {
  render(<RegionPicker getDraft={() => ({ kind: "browser", visual_enabled: false })} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Select region visually" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid Browser URL");
  expect(api).not.toHaveBeenCalled();
});
