import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  compareVisual,
  compareText,
  normalizeText,
  exceedsThreshold,
} from "../src/comparison.js";
export function image(changed = 0, width = 100, height = 100) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  for (let p = 0; p < changed; p++) {
    png.data[p * 4] = 0;
    png.data[p * 4 + 1] = 0;
    png.data[p * 4 + 2] = 0;
  }
  return PNG.sync.write(png);
}
test("zero, tiny changes, 0.35%, equality and 100% are evaluated without rounding", () => {
  const baseline = image();
  assert.equal(compareVisual(baseline, baseline, "0", 0.1).changed, false);
  const tiny = compareVisual(baseline, image(1), "0", 0.1);
  assert.equal(tiny.percent, "0.0100000000");
  assert.equal(tiny.changed, true);
  const precise = compareVisual(baseline, image(35), "0.34", 0.1);
  assert.equal(precise.percent, "0.3500000000");
  assert.equal(precise.changed, true);
  assert.equal(compareVisual(baseline, image(35), "0.35", 0.1).changed, false);
  assert.equal(
    compareVisual(baseline, image(10000), "99.99", 0.1).percent,
    "100.0000000000",
  );
  assert.equal(exceedsThreshold("0.00000000001", "0"), true);
});
test("dimension changes are explicitly 100%, failed decoding fails safely", () => {
  assert.equal(
    compareVisual(image(), image(0, 90, 100), "0.35", 0.1).dimensionChanged,
    true,
  );
  assert.throws(() =>
    compareVisual(image(), Buffer.from("invalid"), "0.35", 0.1),
  );
});
test("literal ignore rules, normalization and highlighted text differences", () => {
  const options = {
    ignore_text: ["dynamic"],
    normalize_whitespace: true,
    ignore_case: true,
  };
  assert.equal(normalizeText(" A  dynamic B\n", options), "a b");
  const result = compareText("old", "new");
  assert.equal(result.changed, true);
  assert.ok(result.parts.some((p) => p.added));
  assert.ok(result.parts.some((p) => p.removed));
});
