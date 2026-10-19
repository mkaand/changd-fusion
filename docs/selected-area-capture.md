# Selected area capture

Selected area capture watches a fixed rectangle of the normal Browser viewport without requiring a CSS or XPath selector. It is additive: Viewport, Full page, and Selected element remain available and existing monitors are unchanged.

## Coordinate contract

The reference viewport is always 1280 × 900 CSS pixels with device scale factor 1. A monitor stores an integer JSON object:

```json
{
  "x": 100,
  "y": 150,
  "width": 320,
  "height": 180
}
```

`x` and `y` are non-negative, width and height are at least 16 pixels, and the complete rectangle must fit within 1280 × 900. Browser zoom, preview scaling, and a phone's device pixel ratio do not change stored coordinates. Interactive edits are clamped to the preview; malformed API values are rejected rather than shifted.

## Capture behavior

The normal pinned-IP proxy, SSRF/DNS/TLS controls, Chromium sandbox, readiness checks, attention detection, Browser Steps, deadline, and global browser admission remain active. Text extraction still uses the complete configured text source. Visual capture produces one validated 1280 × 900 viewport PNG, applies screenshot masks, crops the saved rectangle, and sends only the cropped PNG to the existing Pixelmatch, threshold, History, Timeline, retention, and notification pipeline. A dimension mismatch or invalid/partial PNG fails closed and does not advance the baseline.

Changing the rectangle is a capture-affecting configuration change. The next successful cropped screenshot becomes the new baseline under the existing configuration-change behavior; historical captures and events are retained.

## Preview lifecycle

Selected area reuses the authenticated Region Preview endpoint but does not retain a DOM-selection session. The preview browser, proxy, context, and Chromium admission lease are released before the PNG response completes. Drawing, moving, resizing, zooming, and panning then occur in the client. Cancel, Back, refresh, network failure, and component unmount abort any pending request and do not modify saved monitor settings.

Selected area follows fixed viewport coordinates. If responsive or lazy page layout moves content, the rectangle can contain different pixels. Use Selected element when a DOM target should be followed instead.

## Database migration

Migration `013_selected_area_capture.sql` adds nullable `capture_area` JSONB storage and the `selected_area` capture mode. Existing rows retain their capture mode, selectors, baselines, captures, events, history, and notification preferences. Database constraints and API validation require an exact, bounded rectangle only when `capture_mode` is `selected_area`.
