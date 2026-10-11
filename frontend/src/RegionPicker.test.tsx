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
  vi.mocked(api).mockResolvedValue({ image: "aGVsbG8=", selection: null });
  render(<RegionPicker getDraft={() => draft} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Select region visually" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith(
    "/region-preview",
    "POST",
    { monitor_id: undefined, monitor: { ...draft }, point: undefined },
    { timeoutMs: 125000 },
  ));
  expect(screen.getByAltText("Secure monitor preview")).toBeInTheDocument();
});

it("keeps the form usable after a safe preview error and offers retry and viewport fallback", async () => {
  const retry = new ApiError("Preview timed out. Retry, or use viewport capture instead.", {
    request_id: "safe-request-id",
    preview_stage: "navigation",
    failure_code: "timeout",
  });
  vi.mocked(api).mockRejectedValue(retry);
  const viewport = vi.fn();
  render(<RegionPicker monitorId="00000000-0000-4000-8000-000000000001" getDraft={() => draft} onSelect={vi.fn()} onUseViewport={viewport} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Select region visually" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Preview timed out");
  expect(screen.getByRole("alert")).toHaveTextContent("navigation · timeout · Request safe-request-id");
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert")).toHaveTextContent("Preview timed out");
  await user.click(screen.getByRole("button", { name: "Use viewport instead" }));
  expect(viewport).toHaveBeenCalledOnce();
});

it("does not open a network preview when the visual draft is incomplete", async () => {
  render(<RegionPicker getDraft={() => ({ kind: "browser", visual_enabled: false })} onSelect={vi.fn()} onUseViewport={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Select region visually" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid Browser URL");
  expect(api).not.toHaveBeenCalled();
});
