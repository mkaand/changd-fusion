import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  compareVisual,
  compareText,
  compareKeywordPresence,
  containsKeyword,
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
test("dimension changes have no fabricated percentage and establish a structural event, failed decoding fails safely", () => {
  for (const threshold of ["0", "0.35", "100"]) {
    const result = compareVisual(image(), image(0, 90, 110), threshold, 0.1);
    assert.equal(result.dimensionChanged, true);
    assert.equal(result.percent, null);
    assert.equal(result.changed, true);
    assert.equal(result.diff, null);
    assert.deepEqual(result.beforeDimensions, { width: 100, height: 100 });
    assert.deepEqual(result.afterDimensions, { width: 90, height: 110 });
  }
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

test("keyword presence uses literal Unicode-aware case-insensitive whole words and phrases", () => {
  assert.equal(containsKeyword("Kaan is here", "kaan"), true);
  assert.equal(containsKeyword("Merhaba İSTANBUL", "istanbul"), true);
  assert.equal(containsKeyword("Yeni ürün stokta değil", "ürün stokta"), true);
  assert.equal(containsKeyword("Kaanlı bir sözcük", "Kaan"), false);
  assert.equal(containsKeyword("prefix-v1.2.3 suffix", "v1.2.3"), true);
  assert.equal(containsKeyword("literal a+b value", "a+b"), true);
  assert.equal(containsKeyword("literal aaab value", "a+b"), false);
  assert.equal(containsKeyword("anything", "   "), false);
});

test("keyword presence emits only explicit presence transitions", () => {
  assert.deepEqual(compareKeywordPresence("No matching value", "Kaan arrived", "Kaan"), {
    changed: true,
    parts: [{ value: "Kaan", added: true, removed: false }],
  });
  assert.deepEqual(compareKeywordPresence("Kaan arrived", "No matching value", "Kaan"), {
    changed: true,
    parts: [{ value: "Kaan", added: false, removed: true }],
  });
  assert.deepEqual(compareKeywordPresence("Kaan old text", "Kaan unrelated page update", "Kaan"), {
    changed: false,
    parts: [],
  });
  assert.deepEqual(compareKeywordPresence("Absent old text", "Absent unrelated page update", "Kaan"), {
    changed: false,
    parts: [],
  });
});

test("PNG header limits reject hostile dimensions before decoding or allocation", async () => {
  const { pngDimensions } = await import("../src/image.js");
  const bytes = image();
  bytes.writeUInt32BE(1000000, 16);
  assert.throws(() => pngDimensions(bytes), /exceeds/);
  assert.throws(() => pngDimensions(Buffer.alloc(33)), /Invalid PNG/);
});
