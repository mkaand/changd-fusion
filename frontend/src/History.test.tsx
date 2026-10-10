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
    clipPath: "inset(0 49% 0 0)",
  });
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
  vi.mocked(api).mockResolvedValue([
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
  ]);
  render(<History id="fixture" refresh={0} />);
  expect(
    await screen.findByText("Screenshot dimensions changed"),
  ).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("1280×900 → 1280×2000");
  expect(screen.queryByText("Visual: 100%")).not.toBeInTheDocument();
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
