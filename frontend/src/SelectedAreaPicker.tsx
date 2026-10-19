import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, InputNumber, Modal, Radio, Spin, Typography } from "antd";
import { ApiError, api } from "./api";
import {
  CAPTURE_VIEWPORT_HEIGHT,
  CAPTURE_VIEWPORT_WIDTH,
  MIN_CAPTURE_AREA_SIZE,
  capturePoint,
  clampCaptureArea,
  isValidCaptureArea,
  type CaptureArea,
} from "./capture-area";

const PREVIEW_REQUEST_TIMEOUT_MS = 125000;
const MIN_ZOOM = .5, MAX_ZOOM = 3, ZOOM_STEP = .25;
type Draft = { url?: string; kind?: string; visual_enabled?: boolean; browser_steps?: unknown[]; step_budget_ms?: number; capture_area?: unknown };
type Preview = { image: string; width: number; height: number; timings?: Record<string, number> };
type Tool = "draw" | "pan";
type Action = "draw" | "pan" | "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw" | "pinch";
type Interaction = { action: Action; start: { x: number; y: number }; original?: CaptureArea; left: number; top: number; zoom: number; distance?: number };

const progressLabels: Record<string, string> = { target_validation: "Connecting to website", capacity_wait: "Waiting for available browser capacity", proxy_initialization: "Preparing secure connection", browser_launch: "Starting secure browser", browser_context: "Preparing isolated page", navigation: "Loading page", dom_ready: "Page content loaded", browser_steps: "Applying browser steps", rendering_preparation: "Preparing preview", screenshot: "Rendering screenshot", serialization: "Transferring preview", ready: "Preview ready" };
const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

export function SelectedAreaPicker({ monitorId, getDraft, onApply, mobilePage = false, onRequestMobile, onBackMobile }: {
  monitorId?: string;
  getDraft: () => Draft;
  onApply: (area: CaptureArea) => void;
  mobilePage?: boolean;
  onRequestMobile?: () => void;
  onBackMobile?: () => void;
}) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<Preview | undefined>(undefined), [loading, setLoading] = useState(false), [error, setError] = useState(""), [refreshFailed, setRefreshFailed] = useState(false), [zoom, setZoom] = useState(1), [tool, setTool] = useState<Tool>("draw"), [area, setArea] = useState<CaptureArea>(), [progress, setProgress] = useState("target_validation");
  const canvas = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null), controller = useRef<AbortController | undefined>(undefined), requestVersion = useRef(0), previewRef = useRef<Preview | undefined>(undefined), mounted = useRef(true), pointers = useRef(new Map<number, { x: number; y: number }>()), interaction = useRef<Interaction | undefined>(undefined);

  useEffect(() => { const media = window.matchMedia("(max-width: 767px)"); const update = () => setCompact(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const setCurrentPreview = useCallback((value: Preview | undefined) => { previewRef.current = value; setPreview(value); }, []);
  const abortRequest = useCallback(() => { requestVersion.current++; controller.current?.abort(); controller.current = undefined; }, []);
  const release = useCallback(() => { abortRequest(); pointers.current.clear(); interaction.current = undefined; setCurrentPreview(undefined); setLoading(false); setRefreshFailed(false); }, [abortRequest, setCurrentPreview]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abortRequest(); };
  }, [abortRequest]);

  const load = useCallback(async (reason: "initialize" | "refresh" | "retry" = "initialize") => {
    if (controller.current) return;
    const draft = getDraft();
    if (!draft.url || draft.kind !== "browser" || !draft.visual_enabled) { setError("Enter a valid Browser URL and enable Visual detection before selecting an area."); return; }
    if (reason === "initialize") setArea(isValidCaptureArea(draft.capture_area) ? draft.capture_area : undefined);
    const pending = new AbortController(), version = ++requestVersion.current;
    controller.current = pending; setLoading(true); setError(""); setRefreshFailed(false); setProgress("target_validation");
    const previewRequestId = crypto.randomUUID();
    const isCurrent = () => mounted.current && requestVersion.current === version && controller.current === pending;
    const timer = window.setInterval(() => void api<{ stage: string }>(`/region-preview/status/${previewRequestId}`).then((value) => { if (isCurrent()) setProgress(value.stage); }).catch(() => undefined), 1000);
    try {
      const result = await api<Preview>("/region-preview", "POST", {
        mode: "area", preview_request_id: previewRequestId, monitor_id: monitorId,
        monitor: { url: draft.url, kind: "browser", visual_enabled: true, browser_steps: draft.browser_steps ?? [], step_budget_ms: draft.step_budget_ms ?? 20_000 },
      }, { timeoutMs: PREVIEW_REQUEST_TIMEOUT_MS, signal: pending.signal });
      if (result.width !== CAPTURE_VIEWPORT_WIDTH || result.height !== CAPTURE_VIEWPORT_HEIGHT) throw new Error("Preview dimensions do not match the 1280x900 capture viewport.");
      if (isCurrent()) { setCurrentPreview(result); setProgress("ready"); }
    } catch (cause) {
      if (!pending.signal.aborted && isCurrent()) {
        setError(cause instanceof ApiError ? cause.message : "Website preview failed. Retry preview.");
        setRefreshFailed(Boolean(previewRef.current));
      }
    } finally {
      window.clearInterval(timer);
      if (isCurrent()) { controller.current = undefined; setLoading(false); }
    }
  }, [getDraft, monitorId, setCurrentPreview]);

  useEffect(() => { if (mobilePage) void load("initialize"); }, [mobilePage, load]);
  const point = (clientX: number, clientY: number) => image.current ? capturePoint(clientX, clientY, image.current.getBoundingClientRect()) : { x: 0, y: 0 };
  const updateInteraction = (current: { x: number; y: number }) => {
    const active = interaction.current; if (!active) return;
    if (active.action === "pan") { if (canvas.current) { const scaleX = image.current ? image.current.getBoundingClientRect().width / CAPTURE_VIEWPORT_WIDTH : 1; canvas.current.scrollLeft = active.left - (current.x - active.start.x) * scaleX; canvas.current.scrollTop = active.top - (current.y - active.start.y) * scaleX; } return; }
    const original = active.original;
    if (active.action === "draw") {
      const x = Math.min(active.start.x, current.x), y = Math.min(active.start.y, current.y);
      setArea({ x, y, width: Math.abs(current.x - active.start.x), height: Math.abs(current.y - active.start.y) });
      return;
    }
    if (!original) return;
    const dx = current.x - active.start.x, dy = current.y - active.start.y;
    if (active.action === "move") { setArea(clampCaptureArea({ ...original, x: original.x + dx, y: original.y + dy })); return; }
    let left = original.x, top = original.y, right = original.x + original.width, bottom = original.y + original.height;
    if (active.action.includes("w")) left = Math.min(right - MIN_CAPTURE_AREA_SIZE, Math.max(0, original.x + dx));
    if (active.action.includes("e")) right = Math.max(left + MIN_CAPTURE_AREA_SIZE, Math.min(CAPTURE_VIEWPORT_WIDTH, original.x + original.width + dx));
    if (active.action.includes("n")) top = Math.min(bottom - MIN_CAPTURE_AREA_SIZE, Math.max(0, original.y + dy));
    if (active.action.includes("s")) bottom = Math.max(top + MIN_CAPTURE_AREA_SIZE, Math.min(CAPTURE_VIEWPORT_HEIGHT, original.y + original.height + dy));
    setArea({ x: left, y: top, width: right - left, height: bottom - top });
  };

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!preview || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const values = [...pointers.current.values()];
    if (values.length === 2) {
      if (interaction.current?.action === "draw") setArea(interaction.current.original);
      interaction.current = { action: "pinch", start: point(event.clientX, event.clientY), original: area, left: canvas.current?.scrollLeft ?? 0, top: canvas.current?.scrollTop ?? 0, zoom, distance: Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) };
      return;
    }
    const target = event.target as HTMLElement;
    const action = (target.closest<HTMLElement>("[data-area-action]")?.dataset.areaAction as Action | undefined) ?? (tool === "pan" ? "pan" : "draw");
    const start = point(event.clientX, event.clientY);
    interaction.current = { action, start, original: area, left: canvas.current?.scrollLeft ?? 0, top: canvas.current?.scrollTop ?? 0, zoom };
    if (action === "draw") setArea({ x: start.x, y: start.y, width: 0, height: 0 });
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const values = [...pointers.current.values()], active = interaction.current;
    if (values.length >= 2 && active?.action === "pinch" && active.distance) {
      const distance = Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y);
      setZoom(clampZoom(active.zoom * distance / active.distance));
      return;
    }
    if (active?.action !== "pinch") updateInteraction(point(event.clientX, event.clientY));
  };
  const pointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    try { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
    if (pointers.current.size) return;
    if (area && !isValidCaptureArea(area)) { setArea(interaction.current?.original); setError(`Selected area must be at least ${MIN_CAPTURE_AREA_SIZE} × ${MIN_CAPTURE_AREA_SIZE} px.`); }
    else if (area) setError("");
    interaction.current = undefined;
  };
  const resetView = () => { setZoom(1); if (canvas.current) { canvas.current.scrollLeft = 0; canvas.current.scrollTop = 0; } };
  const updateNumber = (key: keyof CaptureArea, value: number | null) => { if (value === null || !Number.isFinite(value)) return; setArea((current) => clampCaptureArea({ ...(current ?? { x: 0, y: 0, width: 320, height: 180 }), [key]: Math.round(value) })); };
  const cancel = () => { const saved = getDraft().capture_area; release(); setArea(isValidCaptureArea(saved) ? saved : undefined); setOpen(false); };
  const apply = () => { if (!isValidCaptureArea(area)) { setError(`Select an area of at least ${MIN_CAPTURE_AREA_SIZE} × ${MIN_CAPTURE_AREA_SIZE} px.`); return; } onApply(area); release(); setOpen(false); };

  const body = <div className="selected-area-picker">
    <Typography.Paragraph>Draw a fixed rectangle on the 1280 × 900 reference viewport. This area does not follow moving DOM elements; use Selected element for that.</Typography.Paragraph>
    {error && <Alert type="error" showIcon title={error} />}
    {refreshFailed && preview && <Alert type="info" showIcon title="The previous preview is still shown. Retry preview to refresh it." />}
    {loading && !preview && <div className="region-preview-loading" role="status"><Spin /><strong>{progressLabels[progress] ?? "Preparing preview"}</strong></div>}
    {loading && preview && <div className="region-preview-updating" role="status"><Spin size="small" /><span>{progressLabels[progress] ?? "Refreshing preview"}</span></div>}
    {!preview && error && <div className="selected-area-actions"><Button type="primary" onClick={() => void load("retry")} disabled={loading}>Retry preview</Button></div>}
    {preview && <>
      <div className="region-preview-toolbar selected-area-toolbar">
        <Radio.Group value={tool} onChange={(event) => setTool(event.target.value)} aria-label="Selected area interaction mode" optionType="button" options={[{ value: "draw", label: "Draw" }, { value: "pan", label: "Pan" }]} />
        <Button aria-label="Zoom out" onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}>−</Button><output>{Math.round(zoom * 100)}%</output><Button aria-label="Zoom in" onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}>+</Button>
        <Button onClick={resetView}>Fit / Reset</Button><Button onClick={() => void load(error ? "retry" : "refresh")} disabled={loading}>{error ? "Retry preview" : "Refresh preview"}</Button>
      </div>
      <div ref={canvas} className={`region-preview-canvas selected-area-canvas tool-${tool}`}>
        <div className="region-preview-stage selected-area-stage" style={{ width: `${zoom * 100}%` }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}>
          <img ref={image} draggable={false} className="region-preview" src={`data:image/png;base64,${preview.image}`} alt="Secure selected area preview" />
          {area && area.width > 0 && area.height > 0 && <div className="selected-area-box" data-area-action="move" style={{ left: `${area.x / CAPTURE_VIEWPORT_WIDTH * 100}%`, top: `${area.y / CAPTURE_VIEWPORT_HEIGHT * 100}%`, width: `${area.width / CAPTURE_VIEWPORT_WIDTH * 100}%`, height: `${area.height / CAPTURE_VIEWPORT_HEIGHT * 100}%` }}>
            <span className="selected-area-size">{Math.round(area.width)} × {Math.round(area.height)} px</span>
            {(["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const).map((handle) => <span key={handle} className={`selected-area-handle handle-${handle}`} data-area-action={handle} aria-hidden="true" />)}
          </div>}
        </div>
      </div>
      <div className="selected-area-coordinates" aria-label="Selected area coordinates">
        {(["x", "y", "width", "height"] as const).map((key) => <label key={key}><span>{key === "x" || key === "y" ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)}</span><InputNumber aria-label={`Selected area ${key}`} min={key === "width" || key === "height" ? MIN_CAPTURE_AREA_SIZE : 0} max={key === "x" || key === "width" ? CAPTURE_VIEWPORT_WIDTH : CAPTURE_VIEWPORT_HEIGHT} value={area?.[key]} onChange={(value) => updateNumber(key, value)} /></label>)}
      </div>
      <div className="selected-area-actions"><Button onClick={mobilePage ? () => { cancel(); onBackMobile?.(); } : cancel}>Cancel</Button><Button onClick={() => setArea(undefined)} disabled={!area}>Clear</Button><Button type="primary" onClick={apply} disabled={!isValidCaptureArea(area)}>Apply selected area</Button></div>
    </>}
  </div>;

  if (mobilePage) return <section className="mobile-region-picker-page" aria-label="Select screenshot area"><div className="mobile-editor-header"><Button type="text" onClick={() => { cancel(); onBackMobile?.(); }}>← Back</Button><Typography.Title level={4}>Select screenshot area</Typography.Title></div><div className="mobile-region-picker-body">{body}</div></section>;
  return <><Button onClick={() => { if (compact && onRequestMobile) return onRequestMobile(); setOpen(true); resetView(); void load("initialize"); }}>Select area visually</Button>{!compact && <Modal className="region-preview-modal selected-area-modal" title="Select screenshot area" open={open} onCancel={cancel} footer={null} width={960} destroyOnHidden>{body}</Modal>}</>;
}
