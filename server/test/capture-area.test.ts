import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { captureAreaSchema, cropCaptureArea } from "../src/capture-area.js";
import { pngDimensions } from "../src/image.js";

function fixture(width = 1280, height = 900) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      image.data[offset] = x % 256;
      image.data[offset + 1] = y % 256;
      image.data[offset + 2] = (x + y) % 256;
      image.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

test("selected-area validation accepts bounded integer viewport coordinates", () => {
  assert.deepEqual(captureAreaSchema.parse({ x: 0, y: 0, width: 16, height: 16 }), { x: 0, y: 0, width: 16, height: 16 });
  assert.deepEqual(captureAreaSchema.parse({ x: 960, y: 720, width: 320, height: 180 }), { x: 960, y: 720, width: 320, height: 180 });
  for (const invalid of [
    null,
    { x: -1, y: 0, width: 20, height: 20 },
    { x: 0, y: 0, width: 15, height: 20 },
    { x: 1270, y: 0, width: 20, height: 20 },
    { x: 0.5, y: 0, width: 20, height: 20 },
    { x: 0, y: 0, width: 20, height: 20, extra: true },
  ]) assert.throws(() => captureAreaSchema.parse(invalid));
});

test("selected-area crop preserves exact coordinates and produces only the chosen PNG", () => {
  const sourceBytes = fixture();
  const area = { x: 101, y: 151, width: 320, height: 180 };
  const croppedBytes = cropCaptureArea(sourceBytes, area, { width: 4096, height: 8192, pixels: 16_000_000 });
  assert.deepEqual(pngDimensions(croppedBytes), { width: 320, height: 180 });
  const cropped = PNG.sync.read(croppedBytes);
  const pixels = [[0, 0], [160, 90], [319, 179]] as const;
  for (const [x, y] of pixels) {
    const offset = (y * cropped.width + x) * 4;
    assert.deepEqual([...cropped.data.subarray(offset, offset + 4)], [
      (area.x + x) % 256,
      (area.y + y) % 256,
      (area.x + x + area.y + y) % 256,
      255,
    ]);
  }
  assert.ok(croppedBytes.length < sourceBytes.length, "only the selected-area PNG is retained");
});

test("selected-area crop rejects screenshots that do not match the reference viewport", () => {
  assert.throws(
    () => cropCaptureArea(fixture(1279, 900), { x: 0, y: 0, width: 320, height: 180 }, { width: 4096, height: 8192, pixels: 16_000_000 }),
    /exact 1280x900/,
  );
});
