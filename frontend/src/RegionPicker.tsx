import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal, Space, Spin, Typography } from "antd";
import { ApiError, api } from "./api";
const PREVIEW_REQUEST_TIMEOUT_MS = 125000;
const MIN_ZOOM = .5, MAX_ZOOM = 3, ZOOM_STEP = .25;
type Draft = { url?: string; kind?: string; visual_enabled?: boolean; browser_steps?: unknown[] };
type Preview = { session_id?: string; image: string; width: number; height: number; selection?: { selector: string; x: number; y: number; width: number; height: number } | null };
export const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
export const previewPoint = (clientX: number, clientY: number, rect: Pick<DOMRect, "left" | "top" | "width" | "height">) => ({
  x: Math.round((clientX - rect.left) * 1280 / rect.width),
  y: Math.round((clientY - rect.top) * 900 / rect.height),
});

export function RegionPicker({ monitorId, getDraft, onSelect, onUseViewport, mobilePage = false, onRequestMobile, onBackMobile }: {
  monitorId?: string; getDraft: () => Draft; onSelect: (selector: string) => void; onUseViewport: () => void;
  mobilePage?: boolean; onRequestMobile?: () => void; onBackMobile?: () => void;
}) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<Preview>(), [loading, setLoading] = useState(false), [error, setError] = useState<ApiError>(), [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLDivElement>(null);
  const previewImage = useRef<HTMLImageElement>(null);
  const requestPending = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ primaryId: number | null; x: number; y: number; left: number; top: number; distance?: number; zoom: number; moved: boolean; multi: boolean }>({ primaryId: null, x: 0, y: 0, left: 0, top: 0, zoom: 1, moved: false, multi: false });
  useEffect(() => { const media = window.matchMedia("(max-width: 767px)"); const update = () => setCompact(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const load = async (point?: { x: number; y: number }) => {
    if (requestPending.current) return;
    const draft = getDraft();
    if (!draft.url || draft.kind !== "browser" || !draft.visual_enabled) {
      setError(new ApiError("Enter a valid Browser URL and enable Visual detection before previewing a region."));
      return;
    }
    requestPending.current = true;
    setLoading(true);
    try {
      const result = await api("/region-preview", "POST", {
        session_id: point ? preview?.session_id : undefined,
        monitor_id: monitorId,
        monitor: { url: draft.url, kind: "browser", visual_enabled: true, browser_steps: draft.browser_steps ?? [] },
        point,
      }, { timeoutMs: PREVIEW_REQUEST_TIMEOUT_MS }) as Preview;
      setPreview(result); setError(undefined);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError("Website preview failed. Retry, or use viewport capture instead."));
    } finally { requestPending.current = false; setLoading(false); }
  };
  const changeZoom = (next: number) => setZoom(clampZoom(next));
  const pointerDown = (event: React.PointerEvent) => {
    const node = canvas.current; if (!node) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    node.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const values = [...pointers.current.values()];
    if (values.length === 1) {
      gesture.current = { primaryId: event.pointerId, x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop, zoom, moved: false, multi: false };
    } else if (values.length === 2) {
      gesture.current.distance = Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
      gesture.current.zoom = zoom;
      gesture.current.multi = true;
      gesture.current.moved = true;
    }
  };
  const pointerMove = (event: React.PointerEvent) => {
    const node = canvas.current; if (!node || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const values = [...pointers.current.values()];
    if (values.length >= 2 && gesture.current.distance) {
      const distance = Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
      if (Math.abs(distance - gesture.current.distance) > 4) gesture.current.moved = true;
      changeZoom(gesture.current.zoom * distance / gesture.current.distance);
    } else if (zoom > 1 && event.pointerId === gesture.current.primaryId) {
      const dx = event.clientX - gesture.current.x, dy = event.clientY - gesture.current.y;
      if (Math.hypot(dx, dy) > 4) gesture.current.moved = true;
      node.scrollLeft = gesture.current.left - dx; node.scrollTop = gesture.current.top - dy;
    }
  };
  const finishPointer = (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const tracked = pointers.current.has(event.pointerId);
    const shouldSelect = tracked && !cancelled && !gesture.current.moved && !gesture.current.multi && gesture.current.primaryId === event.pointerId && pointers.current.size === 1;
    pointers.current.delete(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {}
    if (pointers.current.size) {
      const remaining = [...pointers.current.entries()][0];
      gesture.current.primaryId = remaining[0];
      gesture.current.x = remaining[1].x;
      gesture.current.y = remaining[1].y;
      gesture.current.left = event.currentTarget.scrollLeft;
      gesture.current.top = event.currentTarget.scrollTop;
      return;
    }
    gesture.current.primaryId = null;
    if (!shouldSelect || requestPending.current) return;
    const image = previewImage.current;
    if (!image) return;
    const rect = image.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.left + rect.width || event.clientY < rect.top || event.clientY > rect.top + rect.height) return;
    void load(previewPoint(event.clientX, event.clientY, rect));
  };
  const reset = () => { setZoom(1); if (canvas.current) { canvas.current.scrollLeft = 0; canvas.current.scrollTop = 0; } };
  const previewBody = <>
    {error && <Alert type="error" title={error.message} description={error.failureCode ? `Preview: ${error.previewStage ?? "unknown"} · ${error.failureCode}${error.requestId ? ` · Request ${error.requestId}` : ""}` : undefined} action={<Space><Button onClick={() => void load()}>Retry</Button><Button onClick={() => { onUseViewport(); setOpen(false); }}>Use viewport instead</Button></Space>} />}
    {loading && !preview && <div className="region-preview-loading" role="status" aria-label="Loading region preview"><Spin /></div>}
    {preview && <>
      <Typography.Paragraph>Use +/− or pinch to zoom. Drag to pan while zoomed, then click or tap a visible element. The preview uses the current form URL through the normal SSRF, TLS, and sandbox restrictions.</Typography.Paragraph>
      <div className="region-preview-toolbar" aria-label="Preview zoom controls">
        <Button aria-label="Zoom out" onClick={() => changeZoom(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}>−</Button>
        <output aria-label="Current zoom">{Math.round(zoom * 100)}%</output>
        <Button aria-label="Zoom in" onClick={() => changeZoom(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}>+</Button>
        <Button onClick={reset}>Fit / Reset</Button>
        {loading && <Spin size="small" aria-label="Resolving selected region" />}
      </div>
      <div ref={canvas} className="region-preview-canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(event) => finishPointer(event, false)} onPointerCancel={(event) => finishPointer(event, true)}>
        <div className="region-preview-stage" style={{ width: `${zoom * 100}%` }}>
          <img ref={previewImage} draggable={false} className="region-preview" src={`data:image/png;base64,${preview.image}`} alt="Secure monitor preview" />
          {preview.selection && <span className="region-preview-highlight" aria-hidden="true" style={{ left: `${preview.selection.x / 1280 * 100}%`, top: `${preview.selection.y / 900 * 100}%`, width: `${preview.selection.width / 1280 * 100}%`, height: `${preview.selection.height / 900 * 100}%` }} />}
        </div>
      </div>
      {preview.selection && <Alert type="success" title="Unique visible element selected" description={preview.selection.selector} action={<Button onClick={() => { onSelect(preview.selection!.selector); setOpen(false); }}>Use selector</Button>} />}
    </>}
  </>;
  useEffect(() => { if (mobilePage) void load(); }, [mobilePage]);
  if (mobilePage) return <section className="mobile-region-picker-page" aria-label="Select screenshot region"><div className="mobile-editor-header"><Button type="text" onClick={onBackMobile}>← Back</Button><Typography.Title level={4}>Select screenshot region</Typography.Title></div><div className="mobile-region-picker-body">{previewBody}</div></section>;
  return <>
    <Button onClick={() => { if (compact && onRequestMobile) return onRequestMobile(); setOpen(true); reset(); void load(); }}>Select region visually</Button>
    {!compact && <Modal className="region-preview-modal" title="Select screenshot region" open={open} onCancel={() => setOpen(false)} footer={null} width={900} destroyOnHidden>{previewBody}</Modal>}
  </>;
}
