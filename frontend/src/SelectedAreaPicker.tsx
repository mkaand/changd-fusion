import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, InputNumber, Radio, Spin, Typography } from "antd";
import { ApiError, api } from "./api";
import { InteractivePreviewSurface } from "./InteractivePreviewSurface";
import { describePreviewWarning } from "./preview-warning";
import { PreviewScrollCoordinator, scrollSteps } from "./preview-scroll-coordinator";
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
type Draft = { url?: string; kind?: string; visual_enabled?: boolean; browser_steps?: unknown[]; step_budget_ms?: number; capture_timeout_ms?: number | null; monitor_http_error_pages?: boolean; disable_javascript?: boolean; block_ads_trackers?: boolean; cookie_banner_handling?: boolean; wait_before_capture_ms?: 0 | 2000 | 5000 | 10000; mobile_view?: boolean; capture_area?: unknown };
type Preview = { session_id?: string; expires_at?: number; image: string; width: number; height: number; scroll_x?: number; scroll_y?: number; http_status?: number; timings?: Record<string, number>; warning?: string };
type Tool = "draw" | "pan";
type Action = "draw" | "pan" | "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw" | "pinch";
type Interaction = { action: Action; start: { x: number; y: number }; original?: CaptureArea; left: number; top: number; zoom: number; distance?: number };

const progressLabels: Record<string, string> = { target_validation: "Connecting to website", capacity_wait: "Waiting for available browser capacity", proxy_initialization: "Preparing secure connection", browser_launch: "Starting secure browser", browser_context: "Preparing isolated page", navigation: "Loading page", dom_ready: "Page content loaded", browser_steps: "Applying browser steps", rendering_preparation: "Preparing preview", screenshot: "Rendering screenshot", serialization: "Transferring preview", ready: "Preview ready" };
const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

export function SelectedAreaPicker({ monitorId, getDraft, onApply, onScrollStep, mobilePage = false, onRequestMobile, onBackMobile }: {
  monitorId?: string;
  getDraft: () => Draft;
  onApply: (area: CaptureArea) => void;
  onScrollStep?: (step: { action: "scroll_by"; x: number; y: number; timeout_ms: number; continue_on_error: false }) => void;
  mobilePage?: boolean;
  onRequestMobile?: () => void;
  onBackMobile?: () => void;
}) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<Preview | undefined>(undefined), [loading, setLoading] = useState(false), [error, setError] = useState<ApiError | undefined>(undefined), [refreshFailed, setRefreshFailed] = useState(false), [zoom, setZoom] = useState(1), [tool, setTool] = useState<Tool>("draw"), [area, setArea] = useState<CaptureArea>(), [progress, setProgress] = useState("target_validation");
  const canvas = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null), controller = useRef<AbortController | undefined>(undefined), requestVersion = useRef(0), previewRef = useRef<Preview | undefined>(undefined), sessionId = useRef<string | undefined>(undefined), initialScroll = useRef({ x: 0, y: 0 }), draftRef = useRef(getDraft), mounted = useRef(true), pointers = useRef(new Map<number, { x: number; y: number }>()), interaction = useRef<Interaction | undefined>(undefined);
  const loadRef = useRef<(reason: "initialize" | "refresh" | "retry" | "scroll", delta?: { x: number; y: number }) => Promise<void>>(undefined);
  const scrollCoordinator = useRef<PreviewScrollCoordinator>(undefined);
  if (!scrollCoordinator.current) scrollCoordinator.current = new PreviewScrollCoordinator(
    (delta) => loadRef.current!("scroll", delta),
    () => !controller.current && Boolean(sessionId.current),
    () => { setLoading(true); setRefreshFailed(true); },
    () => setLoading(false),
  );
  const [pendingScroll, setPendingScroll] = useState({ x: 0, y: 0 });
  draftRef.current = getDraft;

  useEffect(() => { const media = window.matchMedia("(max-width: 767px)"); const update = () => setCompact(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const setCurrentPreview = useCallback((value: Preview | undefined) => { previewRef.current = value; setPreview(value); }, []);
  const abortRequest = useCallback(() => { requestVersion.current++; controller.current?.abort(); controller.current = undefined; }, []);
  const release = useCallback(() => { scrollCoordinator.current?.clear(); abortRequest(); pointers.current.clear(); interaction.current = undefined; const id = sessionId.current; sessionId.current = undefined; if (id) void api(`/region-preview/${id}`, "DELETE").catch(() => undefined); setCurrentPreview(undefined); setLoading(false); setRefreshFailed(false); }, [abortRequest, setCurrentPreview]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scrollCoordinator.current?.clear();
      abortRequest();
      const id = sessionId.current;
      sessionId.current = undefined;
      if (id) void api(`/region-preview/${id}`, "DELETE").catch(() => undefined);
    };
  }, [abortRequest]);

  const load = useCallback(async (reason: "initialize" | "refresh" | "retry" | "scroll" = "initialize", scrollDelta?: { x: number; y: number }) => {
    if (controller.current) return;
    const draft = draftRef.current();
    if (!draft.url || draft.kind !== "browser" || !draft.visual_enabled) { setError(new ApiError("Enter a valid Browser URL and enable Visual detection before selecting an area.")); return; }
    if (draft.mobile_view) { setError(new ApiError("Selected Area uses fixed 1280 × 900 desktop coordinates. Turn off Mobile view or choose another capture mode.")); return; }
    if (reason === "initialize") setArea(isValidCaptureArea(draft.capture_area) ? draft.capture_area : undefined);
    const reusedSession = Boolean(sessionId.current);
    const pending = new AbortController(), version = ++requestVersion.current;
    controller.current = pending; setLoading(true); setError(undefined); setRefreshFailed(false); setProgress("target_validation");
    const previewRequestId = crypto.randomUUID();
    const isCurrent = () => mounted.current && requestVersion.current === version && controller.current === pending;
    const timer = window.setInterval(() => void api<{ stage: string }>(`/region-preview/status/${previewRequestId}`).then((value) => { if (isCurrent()) setProgress(value.stage); }).catch(() => undefined), 1000);
    try {
      const result = await api<Preview>("/region-preview", "POST", {
        mode: "area", preview_request_id: previewRequestId, monitor_id: monitorId,
        ...(reason !== "initialize" && sessionId.current ? { session_id: sessionId.current } : {}),
        refresh: reason === "refresh",
        scroll_delta_x: reason === "scroll" ? scrollDelta?.x : undefined,
        scroll_delta_y: reason === "scroll" ? scrollDelta?.y : undefined,
        monitor: { url: draft.url, kind: "browser", visual_enabled: true, browser_steps: draft.browser_steps ?? [], step_budget_ms: draft.step_budget_ms ?? 20_000, capture_timeout_ms: draft.capture_timeout_ms ?? undefined, monitor_http_error_pages: draft.monitor_http_error_pages, disable_javascript: draft.disable_javascript, block_ads_trackers: draft.block_ads_trackers, cookie_banner_handling: draft.cookie_banner_handling, wait_before_capture_ms: draft.wait_before_capture_ms, mobile_view: draft.mobile_view },
      }, { timeoutMs: PREVIEW_REQUEST_TIMEOUT_MS, signal: pending.signal });
      if (result.width !== CAPTURE_VIEWPORT_WIDTH || result.height !== CAPTURE_VIEWPORT_HEIGHT) throw new Error("Preview dimensions do not match the 1280x900 capture viewport.");
      if (isCurrent()) { sessionId.current = result.session_id; if (reason === "initialize" || (reason === "retry" && !reusedSession)) { initialScroll.current = { x: result.scroll_x ?? 0, y: result.scroll_y ?? 0 }; setPendingScroll({ x: 0, y: 0 }); } if (reason === "scroll") setPendingScroll({ x: (result.scroll_x ?? initialScroll.current.x) - initialScroll.current.x, y: (result.scroll_y ?? initialScroll.current.y) - initialScroll.current.y }); if (!scrollCoordinator.current?.hasPending) { setCurrentPreview(result); setProgress("ready"); setRefreshFailed(false); } }
    } catch (cause) {
      if (!pending.signal.aborted && isCurrent()) {
        if (cause instanceof ApiError && cause.status === 410) { sessionId.current = undefined; scrollCoordinator.current?.clear(); }
        if (reason === "scroll") { sessionId.current = undefined; scrollCoordinator.current?.clear(); }
        setError(cause instanceof ApiError ? cause : new ApiError("Website preview failed. Retry preview."));
        setRefreshFailed(Boolean(previewRef.current));
      }
    } finally {
      window.clearInterval(timer);
      if (isCurrent()) { controller.current = undefined; setLoading(Boolean(scrollCoordinator.current?.hasPending)); scrollCoordinator.current?.resume(); }
    }
  }, [monitorId, setCurrentPreview]);
  loadRef.current = load;

  useEffect(() => {
    if (!preview?.session_id || !preview.expires_at) return;
    const timer = window.setTimeout(() => {
      if (controller.current || scrollCoordinator.current?.hasPending) return;
      sessionId.current = undefined;
      setRefreshFailed(true);
      setError(new ApiError("Preview session expired. Start a fresh Preview before applying the area.", { status: 410, failure_code: "session_expired" }));
    }, Math.max(0, preview.expires_at - Date.now()));
    return () => window.clearTimeout(timer);
  }, [preview?.session_id, preview?.expires_at]);

  useEffect(() => { if (mobilePage) void load("initialize"); }, [mobilePage, load]);
  const point = (clientX: number, clientY: number) => image.current ? capturePoint(clientX, clientY, image.current.getBoundingClientRect()) : { x: 0, y: 0 };
  const updateInteraction = (current: { x: number; y: number }) => {
    const active = interaction.current; if (!active) return;
    if (active.action === "pan") { if (zoom > 1 && canvas.current) { const scaleX = image.current ? image.current.getBoundingClientRect().width / CAPTURE_VIEWPORT_WIDTH : 1; canvas.current.scrollLeft = active.left - (current.x - active.start.x) * scaleX; canvas.current.scrollTop = active.top - (current.y - active.start.y) * scaleX; } return; }
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
    if (tool !== "pan" && (loading || refreshFailed || error)) return;
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
    const active = interaction.current;
    const end = point(event.clientX, event.clientY);
    pointers.current.delete(event.pointerId);
    try { if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
    if (pointers.current.size) return;
    const scroll = active?.action === "pan" && zoom <= 1 ? { x: Math.round(active.start.x - end.x), y: Math.round(active.start.y - end.y) } : undefined;
    if (scroll && (Math.abs(scroll.x) >= 8 || Math.abs(scroll.y) >= 8)) {
      interaction.current = undefined;
      if (sessionId.current) scrollCoordinator.current?.add(scroll);
      return;
    }
    if (area && !isValidCaptureArea(area)) { setArea(interaction.current?.original); setError(new ApiError(`Selected area must be at least ${MIN_CAPTURE_AREA_SIZE} × ${MIN_CAPTURE_AREA_SIZE} px.`)); }
    else if (area) setError(undefined);
    interaction.current = undefined;
  };
  const resetView = () => { setZoom(1); if (canvas.current) { canvas.current.scrollLeft = 0; canvas.current.scrollTop = 0; } };
  const updateNumber = (key: keyof CaptureArea, value: number | null) => { if (value === null || !Number.isFinite(value)) return; setArea((current) => clampCaptureArea({ ...(current ?? { x: 0, y: 0, width: 320, height: 180 }), [key]: Math.round(value) })); };
  const cancel = () => { const saved = getDraft().capture_area; release(); setArea(isValidCaptureArea(saved) ? saved : undefined); setOpen(false); };
  const apply = () => { if (!isValidCaptureArea(area)) { setError(new ApiError(`Select an area of at least ${MIN_CAPTURE_AREA_SIZE} × ${MIN_CAPTURE_AREA_SIZE} px.`)); return; } const steps=scrollSteps(pendingScroll,20-(getDraft().browser_steps?.length??0)); if (!steps) { setError(new ApiError("This scroll exceeds the remaining Browser Steps. Replay Preview with a shorter scroll.")); return; } for(const delta of steps) onScrollStep?.({ action: "scroll_by", ...delta, timeout_ms: 5000, continue_on_error: false }); onApply(area); setPendingScroll({ x: 0, y: 0 }); release(); setOpen(false); };

  const body = <div className="selected-area-picker">
    {error?.status && <Typography.Paragraph>HTTP {error.status}</Typography.Paragraph>}
    {loading && preview && <Alert type="info" title="Previously captured screenshot — refreshing, not a live DOM session" />}
    <Typography.Paragraph>Draw a fixed rectangle on the 1280 × 900 reference viewport. At Fit zoom, Pan scrolls the real browser page and records a replayable Page scroll step; pinch zoom remains local inspection. The saved area keeps the legacy viewport-coordinate contract.</Typography.Paragraph>
    {error && <><Alert type="error" showIcon title={error.message} />{error.failureCode && <Typography.Text type="secondary">{error.previewStage ?? "preview"} · {error.failureCode}{error.previewStep ? ` · step ${error.previewStep}${error.previewAction ? ` (${error.previewAction})` : ""}` : ""}</Typography.Text>}{error.requestId && <details><summary>Technical details</summary><code>Request ID: {error.requestId}</code></details>}</>}
    {refreshFailed && preview && <Alert type="info" showIcon title="The previous preview is still shown. Retry preview to refresh it." />}
    {loading && !preview && <div className="region-preview-loading" role="status"><Spin /><strong>{progressLabels[progress] ?? "Preparing preview"}</strong></div>}
    {loading && preview && <div className="region-preview-updating" role="status"><Spin size="small" /><span>{progressLabels[progress] ?? "Refreshing preview"}</span></div>}
    {!preview && error && <div className="selected-area-actions"><Button type="primary" onClick={() => void load("retry")} disabled={loading}>Retry preview</Button></div>}
    {preview && <>
      {preview.http_status && preview.http_status >= 400 && <Alert className="region-preview-advisory" type="warning" showIcon title={`HTTP ${preview.http_status} error page`} description="The preview was captured successfully, but the origin returned an unsuccessful HTTP status." />}
      {preview.warning && <Alert className="region-preview-advisory" type="warning" showIcon title={describePreviewWarning(preview.warning)} description={<details><summary>Technical details</summary><code>{preview.warning}</code></details>} />}
      <div className="region-preview-toolbar selected-area-toolbar">
        <Radio.Group value={tool} onChange={(event) => setTool(event.target.value)} aria-label="Selected area interaction mode" optionType="button" options={[{ value: "draw", label: "Draw" }, { value: "pan", label: "Pan" }]} />
        <Button aria-label="Zoom out" onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}>−</Button><output>{Math.round(zoom * 100)}%</output><Button aria-label="Zoom in" onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}>+</Button>
        <Button onClick={resetView}>Fit / Reset</Button><Button onClick={() => void load(error ? "retry" : "refresh")} disabled={loading}>{error ? "Retry preview" : "Refresh preview"}</Button>
      </div>
      <InteractivePreviewSurface canvasRef={canvas} imageRef={image} image={preview.image} alt="Secure selected area preview" zoom={zoom}
        canvasClassName={`selected-area-canvas tool-${tool}`} stageClassName="selected-area-stage"
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}>
          {area && area.width > 0 && area.height > 0 && <div className="selected-area-box" data-area-action="move" style={{ left: `${area.x / CAPTURE_VIEWPORT_WIDTH * 100}%`, top: `${area.y / CAPTURE_VIEWPORT_HEIGHT * 100}%`, width: `${area.width / CAPTURE_VIEWPORT_WIDTH * 100}%`, height: `${area.height / CAPTURE_VIEWPORT_HEIGHT * 100}%` }}>
            <span className="selected-area-size">{Math.round(area.width)} × {Math.round(area.height)} px</span>
            {(["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const).map((handle) => <span key={handle} className={`selected-area-handle handle-${handle}`} data-area-action={handle} aria-hidden="true" />)}
          </div>}
      </InteractivePreviewSurface>
      <div className="selected-area-coordinates" aria-label="Selected area coordinates">
        {(["x", "y", "width", "height"] as const).map((key) => <label key={key}><span>{key === "x" || key === "y" ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)}</span><InputNumber aria-label={`Selected area ${key}`} min={key === "width" || key === "height" ? MIN_CAPTURE_AREA_SIZE : 0} max={key === "x" || key === "width" ? CAPTURE_VIEWPORT_WIDTH : CAPTURE_VIEWPORT_HEIGHT} value={area?.[key]} onChange={(value) => updateNumber(key, value)} /></label>)}
      </div>
      <div className="selected-area-actions"><Button onClick={mobilePage ? () => { cancel(); onBackMobile?.(); } : cancel}>Cancel</Button><Button onClick={() => setArea(undefined)} disabled={!area}>Clear</Button><Button type="primary" onClick={apply} disabled={!isValidCaptureArea(area) || loading || refreshFailed || Boolean(error)}>Apply selected area</Button></div>
    </>}
  </div>;

  if (mobilePage) return <section className="mobile-region-picker-page" aria-label="Select screenshot area"><div className="mobile-editor-header"><Button type="text" onClick={() => { cancel(); onBackMobile?.(); }}>← Back</Button><Typography.Title level={4}>Select screenshot area</Typography.Title></div><div className="mobile-region-picker-body">{body}</div></section>;
  return <><Button onClick={() => { if (compact && onRequestMobile) return onRequestMobile(); setOpen(true); resetView(); void load("initialize"); }}>Select area visually</Button>{!compact && open && <section className="interactive-preview-panel" aria-label="Select screenshot area"><Button aria-label="Close" onClick={cancel}>Close preview and continue editing</Button>{body}</section>}</>;
}
