import { describe, expect, it } from "vitest";
import { capturePoint, clampCaptureArea, isValidCaptureArea } from "./capture-area";

describe("selected-area coordinates", () => {
  it("validates strict integer rectangles inside the fixed viewport", () => {
    expect(isValidCaptureArea({ x: 100, y: 150, width: 320, height: 180 })).toBe(true);
    expect(isValidCaptureArea({ x: 1270, y: 890, width: 16, height: 16 })).toBe(false);
    expect(isValidCaptureArea({ x: 0, y: 0, width: 15, height: 16 })).toBe(false);
    expect(isValidCaptureArea({ x: 0.5, y: 0, width: 16, height: 16 })).toBe(false);
    expect(isValidCaptureArea({ x: 0, y: 0, width: 16, height: 16, extra: true })).toBe(false);
  });

  it("maps scaled display coordinates to 1280x900 CSS pixels independent of devicePixelRatio", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 3 });
    expect(capturePoint(330, 245, { left: 10, top: 20, width: 640, height: 450 })).toEqual({ x: 640, y: 450 });
  });

  it("clamps interactive edits without silently accepting an invalid server rectangle", () => {
    expect(clampCaptureArea({ x: 1200, y: 850, width: 320, height: 180 })).toEqual({ x: 960, y: 720, width: 320, height: 180 });
  });
});
