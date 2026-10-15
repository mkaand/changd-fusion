import { Decimal } from "decimal.js";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { diffLines } from "diff";
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
  const a = PNG.sync.read(before),
    b = PNG.sync.read(after);
  if (a.width * a.height > 16_000_000 || b.width * b.height > 16_000_000)
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

const wordCharacter = /[\p{L}\p{M}\p{N}_]/u;

function folded(value: string) {
  // Unicode default lower-casing expands capital dotted I to `i` + combining
  // dot. Collapse that equivalent form so Turkish text matches the literal
  // lowercase spelling without making unrelated accents insensitive.
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/i\u0307/g, "i");
}

function edgeCharacter(value: string, edge: "first" | "last") {
  const characters = Array.from(value);
  return edge === "first" ? characters[0] : characters.at(-1);
}

/**
 * Matches a literal Unicode word or phrase. The monitor keyword is never
 * evaluated as a regular expression, and matches embedded in a larger word
 * are rejected.
 */
export function containsKeyword(text: string, keyword: string) {
  const haystack = folded(text);
  const needle = folded(keyword.trim());
  if (!needle) return false;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) return false;
    const before = edgeCharacter(haystack.slice(0, index), "last");
    const after = edgeCharacter(haystack.slice(index + needle.length), "first");
    if ((!before || !wordCharacter.test(before)) && (!after || !wordCharacter.test(after)))
      return true;
    offset = index + Math.max(1, needle.length);
  }
  return false;
}

export function compareKeywordPresence(before: string, after: string, keyword: string) {
  const wasPresent = containsKeyword(before, keyword);
  const isPresent = containsKeyword(after, keyword);
  if (wasPresent === isPresent) return { changed: false, parts: [] };
  return {
    changed: true,
    parts: [{
      value: keyword,
      added: isPresent,
      removed: wasPresent,
    }],
  };
}
export interface VisualComparator {
  compare: typeof compareVisual;
}
export const pixelmatchComparator: VisualComparator = {
  compare: compareVisual,
};
