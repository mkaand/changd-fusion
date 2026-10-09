import { Decimal } from "decimal.js";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { diffLines } from "diff";
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
  const a = PNG.sync.read(before),
    b = PNG.sync.read(after);
  if (a.width * a.height > 16_000_000 || b.width * b.height > 16_000_000)
    throw Error("Image exceeds pixel limit");
  if (a.width !== b.width || a.height !== b.height)
    return {
      percent: "100",
      changed: exceedsThreshold("100", threshold),
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
    diff: PNG.sync.write(diff),
  };
}
export function normalizeText(
  text: string,
  options: {
    ignore_text: string[];
    normalize_whitespace: boolean;
    ignore_case: boolean;
  },
) {
  // Literal ignore strings avoid user-controlled catastrophic regular expressions.
  for (const value of options.ignore_text)
    if (value) text = text.split(value).join("");
  if (options.normalize_whitespace) text = text.replace(/\s+/g, " ").trim();
  if (options.ignore_case) text = text.toLocaleLowerCase("en-US");
  return text;
}
export function compareText(before: string, after: string) {
  return {
    changed: before !== after,
    parts: diffLines(before, after).map(({ value, added, removed }) => ({
      value,
      added: !!added,
      removed: !!removed,
    })),
  };
}
export interface VisualComparator {
  compare: typeof compareVisual;
}
export const pixelmatchComparator: VisualComparator = {
  compare: compareVisual,
};
