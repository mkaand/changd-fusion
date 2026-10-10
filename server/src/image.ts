import { HttpError } from "./errors.js";
// Inspect IHDR before pngjs allocates decoded RGBA buffers. Absolute limits also
// protect comparisons of persisted or injected captures, independently of config.
export const IMAGE_LIMITS = { width: 4096, height: 8192, pixels: 16_000_000 };
export type Dimensions = { width: number; height: number };
export function checkDimensions(size: Dimensions, limits = IMAGE_LIMITS) {
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    size.width > limits.width ||
    size.height > limits.height ||
    size.width * size.height > limits.pixels
  )
    throw new HttpError(
      400,
      "Capture exceeds image dimension/pixel limits. Choose a smaller region or viewport.",
    );
  return size;
}
export function pngDimensions(
  bytes: Buffer,
  limits = IMAGE_LIMITS,
): Dimensions {
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(8) !== 13
  )
    throw Error("Invalid PNG header");
  return checkDimensions(
    { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
    limits,
  );
}
