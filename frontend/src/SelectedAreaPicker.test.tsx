import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { SelectedAreaPicker } from "./SelectedAreaPicker";

vi.mock("./api", async () => ({ ...(await vi.importActual<typeof import("./api")>("./api")), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const draft = { url: "https://fixture.example/product", kind: "browser", visual_enabled: true, browser_steps: [], name: "Unsaved name" };
const preview = { image: "iVBORw0KGgo=", width: 1280, height: 900 };
const mockPreview = () => vi.mocked(api).mockImplementation((path: string) => Promise.resolve(path.startsWith("/region-preview/status/") ? { stage: "screenshot" } : preview));

it("supports mouse drawing in the desktop modal", async () => {
  mockPreview();
  const apply = vi.fn();
  render(<SelectedAreaPicker getDraft={() => draft} onApply={apply} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Select area visually" }));
  const image = await screen.findByAltText("Secure selected area preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1280, height: 900 }) });
  const stage = image.closest(".selected-area-stage")!;
  fireEvent.pointerDown(stage, { pointerId: 30, pointerType: "mouse", button: 0, clientX: 25, clientY: 30 });
  fireEvent.pointerMove(stage, { pointerId: 30, pointerType: "mouse", clientX: 225, clientY: 130 });
  fireEvent.pointerUp(stage, { pointerId: 30, pointerType: "mouse", clientX: 225, clientY: 130 });
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply selected area" }));
  expect(apply).toHaveBeenCalledWith({ x: 25, y: 30, width: 200, height: 100 });
});

it("draws and applies fixed viewport coordinates with the real mobile picker", async () => {
  mockPreview();
  const apply = vi.fn();
  render(<SelectedAreaPicker mobilePage getDraft={() => draft} onApply={apply} onBackMobile={vi.fn()} />);
  const image = await screen.findByAltText("Secure selected area preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 10, top: 20, width: 640, height: 450 }) });
  const stage = image.closest(".selected-area-stage")!;
  fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 60, clientY: 70 });
  fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "touch", clientX: 220, clientY: 160 });
  fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch", clientX: 220, clientY: 160 });
  expect(screen.getByText("320 × 180 px")).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply selected area" }));
  expect(apply).toHaveBeenCalledWith({ x: 100, y: 100, width: 320, height: 180 });
  expect(api).toHaveBeenCalledWith("/region-preview", "POST", expect.objectContaining({ mode: "area" }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(vi.mocked(api).mock.calls[0][2]).not.toHaveProperty("session_id");
});

it("keeps the saved area unchanged on Back and cancels an in-flight preview", async () => {
  let signal: AbortSignal | undefined;
  vi.mocked(api).mockImplementation((_path: string, _method?: string, _body?: unknown, options?: { signal?: AbortSignal }) => {
    signal = options?.signal;
    return new Promise(() => undefined);
  });
  const back = vi.fn(), apply = vi.fn();
  render(<SelectedAreaPicker mobilePage getDraft={() => ({ ...draft, capture_area: { x: 10, y: 20, width: 100, height: 80 } })} onApply={apply} onBackMobile={back} />);
  await waitFor(() => expect(signal).toBeDefined());
  await userEvent.setup().click(screen.getByRole("button", { name: "← Back" }));
  expect(signal?.aborted).toBe(true);
  expect(back).toHaveBeenCalledOnce();
  expect(apply).not.toHaveBeenCalled();
});

it("offers one retry after a capacity error and keeps rapid retry clicks single-flight", async () => {
  let requests = 0;
  vi.mocked(api).mockImplementation((path: string) => {
    if (path.startsWith("/region-preview/status/")) return Promise.resolve({ stage: "browser_launch" });
    requests++;
    return requests === 1
      ? Promise.reject(new ApiError("Preview capacity is busy. Retry shortly.", { failure_code: "capacity_busy", status: 429 }))
      : Promise.resolve(preview);
  });
  render(<SelectedAreaPicker mobilePage getDraft={() => draft} onApply={vi.fn()} onBackMobile={vi.fn()} />);
  expect(await screen.findByText("Preview capacity is busy. Retry shortly.")).toBeInTheDocument();
  const retry = screen.getByRole("button", { name: "Retry preview" });
  await userEvent.setup().click(retry);
  fireEvent.click(retry);
  expect(await screen.findByAltText("Secure selected area preview")).toBeInTheDocument();
  expect(requests).toBe(2);
});

it("preserves an unapplied area through refresh failure and retry", async () => {
  let requests = 0;
  vi.mocked(api).mockImplementation((path: string) => {
    if (path.startsWith("/region-preview/status/")) return Promise.resolve({ stage: "screenshot" });
    requests++;
    if (requests === 2) return Promise.reject(new ApiError("Preview request failed. Retry.", { status: 503 }));
    return Promise.resolve(preview);
  });
  const apply = vi.fn();
  render(<SelectedAreaPicker mobilePage getDraft={() => draft} onApply={apply} onBackMobile={vi.fn()} />);
  const image = await screen.findByAltText("Secure selected area preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1280, height: 900 }) });
  const stage = image.closest(".selected-area-stage")!;
  fireEvent.pointerDown(stage, { pointerId: 21, pointerType: "mouse", button: 0, clientX: 100, clientY: 120 });
  fireEvent.pointerMove(stage, { pointerId: 21, pointerType: "mouse", clientX: 420, clientY: 300 });
  fireEvent.pointerUp(stage, { pointerId: 21, pointerType: "mouse", clientX: 420, clientY: 300 });
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh preview" }));
  expect(await screen.findByText("Preview request failed. Retry.")).toBeInTheDocument();
  expect(screen.getByText("320 × 180 px")).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry preview" }));
  await waitFor(() => expect(screen.queryByText("Preview request failed. Retry.")).not.toBeInTheDocument());
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply selected area" }));
  expect(apply).toHaveBeenCalledWith({ x: 100, y: 120, width: 320, height: 180 });
  expect(requests).toBe(3);
});

it("preserves moved, resized, and numeric temporary coordinates through refresh", async () => {
  mockPreview();
  const apply = vi.fn();
  render(<SelectedAreaPicker mobilePage getDraft={() => ({ ...draft, capture_area: { x: 40, y: 50, width: 200, height: 100 } })} onApply={apply} onBackMobile={vi.fn()} />);
  const image = await screen.findByAltText("Secure selected area preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1280, height: 900 }) });
  const stage = image.closest(".selected-area-stage")!, box = stage.querySelector(".selected-area-box")!;
  fireEvent.pointerDown(box, { pointerId: 22, pointerType: "mouse", button: 0, clientX: 100, clientY: 80 });
  fireEvent.pointerMove(stage, { pointerId: 22, pointerType: "mouse", clientX: 120, clientY: 110 });
  fireEvent.pointerUp(stage, { pointerId: 22, pointerType: "mouse", clientX: 120, clientY: 110 });
  fireEvent.change(screen.getByLabelText("Selected area width"), { target: { value: "260" } });
  await userEvent.setup().click(screen.getByRole("button", { name: "Refresh preview" }));
  await waitFor(() => expect(vi.mocked(api).mock.calls.filter(([path]) => path === "/region-preview")).toHaveLength(2));
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply selected area" }));
  expect(apply).toHaveBeenCalledWith({ x: 60, y: 80, width: 260, height: 100 });
});

it("does not turn a two-finger pinch into a new selection", async () => {
  mockPreview();
  render(<SelectedAreaPicker mobilePage getDraft={() => ({ ...draft, capture_area: { x: 40, y: 50, width: 200, height: 100 } })} onApply={vi.fn()} onBackMobile={vi.fn()} />);
  const image = await screen.findByAltText("Secure selected area preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 640, height: 450 }) });
  const stage = image.closest(".selected-area-stage")!;
  fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
  fireEvent.pointerDown(stage, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
  fireEvent.pointerMove(stage, { pointerId: 2, pointerType: "touch", clientX: 250, clientY: 100 });
  fireEvent.pointerUp(stage, { pointerId: 2, pointerType: "touch", clientX: 250, clientY: 100 });
  fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
  expect(screen.getByText("200 × 100 px")).toBeInTheDocument();
});

it("moves and resizes an existing area while Pan mode leaves it unchanged", async () => {
  mockPreview();
  render(<SelectedAreaPicker mobilePage getDraft={() => ({ ...draft, capture_area: { x: 40, y: 50, width: 200, height: 100 } })} onApply={vi.fn()} onBackMobile={vi.fn()} />);
  const image = await screen.findByAltText("Secure selected area preview");
  Object.defineProperty(image, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1280, height: 900 }) });
  const stage = image.closest(".selected-area-stage")!;
  const box = stage.querySelector(".selected-area-box")!;
  fireEvent.pointerDown(box, { pointerId: 3, pointerType: "mouse", button: 0, clientX: 100, clientY: 80 });
  fireEvent.pointerMove(stage, { pointerId: 3, pointerType: "mouse", clientX: 120, clientY: 110 });
  fireEvent.pointerUp(stage, { pointerId: 3, pointerType: "mouse", clientX: 120, clientY: 110 });
  await waitFor(() => expect(screen.getByLabelText("Selected area x")).toHaveValue("60"));
  expect(screen.getByLabelText("Selected area y")).toHaveValue("80");
  const handle = stage.querySelector(".handle-se")!;
  fireEvent.pointerDown(handle, { pointerId: 4, pointerType: "touch", clientX: 260, clientY: 180 });
  fireEvent.pointerMove(stage, { pointerId: 4, pointerType: "touch", clientX: 300, clientY: 200 });
  fireEvent.pointerUp(stage, { pointerId: 4, pointerType: "touch", clientX: 300, clientY: 200 });
  await waitFor(() => expect(screen.getByLabelText("Selected area width")).toHaveValue("240"));
  expect(screen.getByLabelText("Selected area height")).toHaveValue("120");
  await userEvent.setup().click(screen.getByText("Pan", { exact: true }));
  fireEvent.pointerDown(stage, { pointerId: 5, pointerType: "touch", clientX: 500, clientY: 400 });
  fireEvent.pointerMove(stage, { pointerId: 5, pointerType: "touch", clientX: 400, clientY: 300 });
  fireEvent.pointerUp(stage, { pointerId: 5, pointerType: "touch", clientX: 400, clientY: 300 });
  expect(screen.getByLabelText("Selected area x")).toHaveValue("60");
  expect(screen.getByLabelText("Selected area width")).toHaveValue("240");
});
