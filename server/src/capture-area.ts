import { PNG } from "pngjs";
import { z } from "zod";
import { HttpError } from "./errors.js";
import { checkDimensions, pngDimensions, type Dimensions } from "./image.js";

export const CAPTURE_VIEWPORT = { width: 1280, height: 900 } as const;
export const MIN_CAPTURE_AREA_SIZE = 16;

export const captureAreaSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().min(MIN_CAPTURE_AREA_SIZE).max(CAPTURE_VIEWPORT.width),
  height: z.number().int().min(MIN_CAPTURE_AREA_SIZE).max(CAPTURE_VIEWPORT.height),
}).strict().refine(
  (area) => area.x + area.width <= CAPTURE_VIEWPORT.width && area.y + area.height <= CAPTURE_VIEWPORT.height,
  { message: "Selected area must fit inside the 1280x900 capture viewport" },
);

export type CaptureArea = z.infer<typeof captureAreaSchema>;

export function cropCaptureArea(bytes: Buffer, input: CaptureArea, limits: Dimensions & { pixels: number }) {
  const area = captureAreaSchema.parse(input);
  const dimensions = pngDimensions(bytes, limits);
  if (dimensions.width !== CAPTURE_VIEWPORT.width || dimensions.height !== CAPTURE_VIEWPORT.height)
    throw new HttpError(422, "Selected area capture requires an exact 1280x900 viewport screenshot.");

  const source = PNG.sync.read(bytes, { checkCRC: true });
  const output = new PNG({ width: area.width, height: area.height });
  for (let row = 0; row < area.height; row++) {
    const sourceStart = ((area.y + row) * source.width + area.x) * 4;
    const outputStart = row * area.width * 4;
    source.data.copy(output.data, outputStart, sourceStart, sourceStart + area.width * 4);
  }
  checkDimensions({ width: output.width, height: output.height }, limits);
  const encoded = PNG.sync.write(output);
  pngDimensions(encoded, limits);
  return encoded;
}
