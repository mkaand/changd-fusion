export const CAPTURE_VIEWPORT_WIDTH = 1280;
export const CAPTURE_VIEWPORT_HEIGHT = 900;
export const MIN_CAPTURE_AREA_SIZE = 16;

export type CaptureArea = { x: number; y: number; width: number; height: number };

export function isValidCaptureArea(value: unknown): value is CaptureArea {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const area = value as Record<string, unknown>;
  if (Object.keys(area).some((key) => !["x", "y", "width", "height"].includes(key))) return false;
  const { x, y, width, height } = area;
  return [x, y, width, height].every(Number.isInteger) &&
    (x as number) >= 0 && (y as number) >= 0 &&
    (width as number) >= MIN_CAPTURE_AREA_SIZE && (height as number) >= MIN_CAPTURE_AREA_SIZE &&
    (x as number) + (width as number) <= CAPTURE_VIEWPORT_WIDTH &&
    (y as number) + (height as number) <= CAPTURE_VIEWPORT_HEIGHT;
}

export function clampCaptureArea(value: CaptureArea): CaptureArea {
  const width = Math.min(CAPTURE_VIEWPORT_WIDTH, Math.max(MIN_CAPTURE_AREA_SIZE, Math.round(value.width)));
  const height = Math.min(CAPTURE_VIEWPORT_HEIGHT, Math.max(MIN_CAPTURE_AREA_SIZE, Math.round(value.height)));
  return {
    x: Math.min(CAPTURE_VIEWPORT_WIDTH - width, Math.max(0, Math.round(value.x))),
    y: Math.min(CAPTURE_VIEWPORT_HEIGHT - height, Math.max(0, Math.round(value.y))),
    width,
    height,
  };
}

export function capturePoint(clientX: number, clientY: number, rect: Pick<DOMRect, "left" | "top" | "width" | "height">) {
  return {
    x: Math.min(CAPTURE_VIEWPORT_WIDTH, Math.max(0, Math.round((clientX - rect.left) * CAPTURE_VIEWPORT_WIDTH / rect.width))),
    y: Math.min(CAPTURE_VIEWPORT_HEIGHT, Math.max(0, Math.round((clientY - rect.top) * CAPTURE_VIEWPORT_HEIGHT / rect.height))),
  };
}
