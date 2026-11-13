import { Decimal } from "decimal.js";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { pngDimensions } from "./image.js";
export function exceedsThreshold(percent: string, threshold: string): boolean {
  // Strictly greater: zero never changes, equality does not alert. No pre-evaluation rounding.
  return new Decimal(percent).greaterThan(threshold);
}
export function compareVisual(
  before: Buffer,
  after: Buffer,
  threshold: string,
  pixelThreshold: number,
) {
  const beforeDimensions = pngDimensions(before),
    afterDimensions = pngDimensions(after);
  const a = PNG.sync.read(before);
  if (a.width * a.height > 16_000_000)
    throw Error("Image exceeds pixel limit");
  // Decode the first image even for identical bytes: corrupt stored PNGs must
  // still fail instead of being reported as a valid zero-difference capture.
  if (before.equals(after)) return {
    percent: "0.0000000000",
    changed: false,
    dimensionChanged: false,
    beforeDimensions,
    afterDimensions,
    diff: null,
  };
  const b = PNG.sync.read(after);
  if (b.width * b.height > 16_000_000)
    throw Error("Image exceeds pixel limit");
  if (a.width !== b.width || a.height !== b.height)
    return {
      percent: null,
      // A structural event is independent of the percentage threshold; no pixel measurement exists.
      changed: true,
      beforeDimensions,
      afterDimensions,
      dimensionChanged: true,
      diff: null,
    };
  const diff = new PNG({ width: a.width, height: a.height });
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: pixelThreshold,
    includeAA: false,
  });
  const precise = new Decimal(pixels).times(100).dividedBy(a.width * a.height);
  return {
    percent: precise.toFixed(10),
    changed: precise.greaterThan(threshold),
    dimensionChanged: false,
    beforeDimensions,
    afterDimensions,
    diff: pixels === 0 ? null : PNG.sync.write(diff),
  };
}
export { normalizeText, compareText, containsKeyword, compareKeywordPresence } from "./text-comparison.js";

export interface VisualComparator {
  compare: typeof compareVisual;
}
export const pixelmatchComparator: VisualComparator = {
  compare: compareVisual,
};
