import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { it, expect, afterEach, vi } from "vitest";
import { ImageComparison, History } from "./History";
import { api } from "./api";
vi.mock("./api", async () => ({
  ...(await vi.importActual("./api")),
  api: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("comparison slider has a keyboard-accessible label and changes the image overlay", () => {
  render(<ImageComparison before="before.png" after="after.png" />);
  const slider = screen.getByRole("slider", {
    name: "Before / After comparison",
  });
  expect(slider).toHaveAttribute("aria-valuenow", "50");
  fireEvent.keyDown(slider, { key: "ArrowRight", keyCode: 39 });
  expect(slider).toHaveAttribute("aria-valuenow", "51");
  expect(screen.getByAltText("After capture")).toHaveStyle({
    clipPath: "inset(0 0 0 51%)",
  });
});
it("dragging directly over a screenshot updates and clamps the comparison, with safe pointer release", () => {
  render(<ImageComparison before="before.png" after="after.png" />);
  const image = screen.getByRole("group", { name: "Drag to compare before and after" });
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({ left: 10, width: 200 } as DOMRect);
  fireEvent.pointerDown(image, { pointerId: 7, pointerType: "touch", clientX: 160 });
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "75");
  fireEvent.pointerMove(image, { pointerId: 7, pointerType: "touch", clientX: 290 });
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "100");
  fireEvent.pointerUp(image, { pointerId: 7, pointerType: "touch", clientX: 290 });
  fireEvent.pointerMove(image, { pointerId: 7, pointerType: "touch", clientX: 30 });
  expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "100");
});

it("dimension changes show separate images rather than overlaying incompatible sizes", () => {
  render(
    <ImageComparison before="before.png" after="after.png" dimensionChanged />,
  );
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  expect(screen.getByAltText("Before capture")).toBeInTheDocument();
  expect(screen.getByAltText("After capture")).toBeInTheDocument();
  fireEvent.error(screen.getByAltText("After capture"));
  expect(screen.getByRole("alert")).toHaveTextContent("image is unavailable");
});
it("history explains dimension changes without displaying a fabricated percentage", async () => {
  vi.mocked(api).mockResolvedValue({
    items: [
      {
        id: "fixture",
        status: "changed",
        created_at: "2026-01-01",
        visual_percent: null,
        dimension_changed: true,
        before_dimensions: { width: 1280, height: 900 },
        after_dimensions: { width: 1280, height: 2000 },
        before_image: "before.png",
        after_image: "after.png",
      },
    ],
    total: 1,
  });
  render(<History id="fixture" refresh={0} />);
  expect(
    await screen.findByText("Screenshot dimensions changed"),
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("1280×900 → 1280×2000");
  expect(screen.queryByText("Visual: 100%")).not.toBeInTheDocument();
});

it("groups monitoring history content for consistent mobile spacing", async () => {
  vi.mocked(api).mockResolvedValue({ items: [], total: 0 } as never);
  render(<History id="fixture" refresh={0} />);
  expect(screen.getByRole("region", { name: "Monitoring history" })).toHaveClass("monitor-history");
});
it("history reports API errors and has an accessible loading state", async () => {
  vi.mocked(api).mockRejectedValue(Error("History unavailable"));
  render(<History id="fixture" refresh={0} />);
  expect(
    screen.getByRole("status", { name: "Loading monitoring history" }),
  ).toBeInTheDocument();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "History unavailable",
  );
});
it("history paginates and explains capture configuration changes independently of content changes", async () => {
  vi.mocked(api).mockResolvedValue({
    items: [
      {
        id: "reset",
        status: "reset",
        created_at: "2026-01-01",
        visual_percent: null,
        configuration_changed: true,
      },
    ],
    total: 21,
  });
  render(<History id="fixture" refresh={0} />);
  expect(
    await screen.findByText("Capture configuration changed"),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByTitle("2"));
  expect(api).toHaveBeenCalledWith("/jobs/fixture/history?page=2&page_size=20");
});
