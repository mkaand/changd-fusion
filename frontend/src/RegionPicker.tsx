import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, InputNumber, Modal, Select, Space, Spin, Switch, Typography } from "antd";
import { ApiError, api } from "./api";
const PREVIEW_REQUEST_TIMEOUT_MS = 125000;
const MIN_ZOOM = .5, MAX_ZOOM = 3, ZOOM_STEP = .25;
type Draft = { url?: string; kind?: string; visual_enabled?: boolean; browser_steps?: unknown[]; step_budget_ms?: number; capture_timeout_ms?: number | null; monitor_http_error_pages?: boolean; disable_javascript?: boolean; block_ads_trackers?: boolean; cookie_banner_handling?: boolean; wait_before_capture_ms?: 0 | 2000 | 5000 | 10000; mobile_view?: boolean };
type Selection = { selector: string; label?: string; x: number; y: number; width: number; height: number };
type Preview = { session_id?: string; image: string; width: number; height: number; http_status?: number; selection?: Selection | null; candidates?: Selection[]; timings?: Record<string, number>; warning?: string; reused?: boolean };
export type VisualBrowserStep = { action: "click" | "wait_visible" | "wait_selector" | "dismiss_cookie" | "scroll_to"; selector: string; selector_type: "css"; timeout_ms: number; continue_on_error: boolean };
const progressLabels: Record<string, string> = { target_validation: "Connecting to website", capacity_wait: "Waiting for available browser capacity", proxy_initialization: "Preparing secure connection", browser_launch: "Starting secure browser", browser_context: "Preparing isolated page", navigation: "Loading page", dom_ready: "Page content loaded", browser_steps: "Applying browser steps", rendering_preparation: "Preparing preview", screenshot: "Rendering screenshot", serialization: "Transferring preview", ready: "Preview ready" };
export const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
export const previewPoint = (clientX: number, clientY: number, rect: Pick<DOMRect, "left" | "top" | "width" | "height">, image: { width: number; height: number } = { width: 1280, height: 900 }) => ({
  x: Math.round((clientX - rect.left) * image.width / rect.width),
  y: Math.round((clientY - rect.top) * image.height / rect.height),
});

export function RegionPicker({ monitorId, getDraft, onSelect, onUseViewport, mobilePage = false, onRequestMobile, onBackMobile, purpose = "region", onAddStep }: {
  monitorId?: string; getDraft: () => Draft; onSelect: (selector: string) => void; onUseViewport: () => void;
  mobilePage?: boolean; onRequestMobile?: () => void; onBackMobile?: () => void;
  purpose?: "region" | "step"; onAddStep?: (step: VisualBrowserStep) => void;
}) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<Preview>(), [loading, setLoading] = useState(false), [error, setError] = useState<ApiError>(), [zoom, setZoom] = useState(1), [progress, setProgress] = useState("target_validation"), [clientTiming, setClientTiming] = useState<{ transfer?: number; decode?: number }>({});
  const [stepAction, setStepAction] = useState<VisualBrowserStep["action"]>("click"), [stepTimeout, setStepTimeout] = useState(5000), [stepOptional, setStepOptional] = useState(false), [workflowChanged, setWorkflowChanged] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const previewImage = useRef<HTMLImageElement>(null);
  const requestPending = useRef(false);
  const requestController = useRef<AbortController | undefined>(undefined);
  const sessionId = useRef<string | undefined>(undefined);
  const lastPoint = useRef<{ x: number; y: number } | undefined>(undefined);
  const imageDecodeStarted = useRef(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ primaryId: number | null; x: number; y: number; left: number; top: number; distance?: number; zoom: number; moved: boolean; multi: boolean }>({ primaryId: null, x: 0, y: 0, left: 0, top: 0, zoom: 1, moved: false, multi: false });
  useEffect(() => { const media = window.matchMedia("(max-width: 767px)"); const update = () => setCompact(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const releaseSession = useCallback(() => {
    requestController.current?.abort();
    requestController.current = undefined;
    requestPending.current = false;
    const id = sessionId.current;
    sessionId.current = undefined;
    setPreview(undefined);
    if (id) void api(`/region-preview/${id}`, "DELETE").catch(() => undefined);
  }, []);
  useEffect(() => () => releaseSession(), [releaseSession]);
  const load = async (point?: { x: number; y: number }, refreshSession = false) => {
    if (requestPending.current) return;
    const draft = getDraft();
    if (!draft.url || draft.kind !== "browser" || (purpose === "region" && !draft.visual_enabled)) {
      setError(new ApiError(purpose === "step" ? "Enter a valid Browser URL before opening the step preview." : "Enter a valid Browser URL and enable Visual detection before previewing a region."));
      return;
    }
    requestPending.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setError(undefined);
    if (point) lastPoint.current = point;
    else { lastPoint.current = undefined; setProgress("target_validation"); }
    const previewRequestId = crypto.randomUUID();
    const requestStarted = performance.now();
    const progressTimer = point ? undefined : window.setInterval(() => { void api<{ stage: string }>(`/region-preview/status/${previewRequestId}`).then((value) => setProgress(value.stage)).catch(() => undefined); }, 1000);
    try {
      const result = await api("/region-preview", "POST", {
        session_id: point || refreshSession ? sessionId.current : undefined,
        refresh: refreshSession,
        preview_request_id: previewRequestId,
        monitor_id: monitorId,
        monitor: { url: draft.url, kind: "browser", visual_enabled: true, browser_steps: draft.browser_steps ?? [], step_budget_ms: draft.step_budget_ms ?? 20_000, capture_timeout_ms: draft.capture_timeout_ms ?? undefined, monitor_http_error_pages: draft.monitor_http_error_pages, disable_javascript: draft.disable_javascript, block_ads_trackers: draft.block_ads_trackers, cookie_banner_handling: draft.cookie_banner_handling, wait_before_capture_ms: draft.wait_before_capture_ms, mobile_view: draft.mobile_view },
        point,
      }, { timeoutMs: PREVIEW_REQUEST_TIMEOUT_MS, signal: controller.signal }) as Preview;
      sessionId.current = result.session_id;
      imageDecodeStarted.current = performance.now(); setPreview(result); setError(undefined); setProgress("ready"); setWorkflowChanged(false); setClientTiming({ transfer: Math.round(performance.now() - requestStarted - Object.values(result.timings ?? {}).reduce((sum, value) => sum + value, 0)) });
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 410) sessionId.current = undefined;
      if (cause instanceof ApiError && cause.failureCode === "stale_configuration") { sessionId.current = undefined; setPreview(undefined); }
      setError(cause instanceof ApiError ? cause : new ApiError("Website preview failed. Retry, or use viewport capture instead."));
    } finally { if (progressTimer) window.clearInterval(progressTimer); if (requestController.current === controller) { requestController.current = undefined; requestPending.current = false; setLoading(false); } }
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
    void load(previewPoint(event.clientX, event.clientY, rect, preview ?? { width: 1280, height: 900 }));
  };
  const replay = () => { releaseSession(); window.setTimeout(() => void load(), 0); };
  const reset = () => { setZoom(1); if (canvas.current) { canvas.current.scrollLeft = 0; canvas.current.scrollTop = 0; } };
  const previewBody = <>
    {error && <div className="region-preview-error" role="alert" aria-live="assertive"><strong>{error.message}</strong><p>{error.failureCode ? `${error.previewStage ?? "preview"} · ${error.failureCode}${error.previewStep ? ` · step ${error.previewStep}${error.previewAction ? ` (${error.previewAction})` : ""}` : ""}` : "The preview could not be completed."}</p><div className="region-preview-error-actions">{preview?.session_id && lastPoint.current && error.status !== 410 && <Button onClick={() => void load(lastPoint.current, error.failureCode === "stale_preview")}>Retry selection</Button>}<Button onClick={() => void load()}>Refresh preview</Button>{purpose === "region" && <Button onClick={() => { onUseViewport(); releaseSession(); setOpen(false); }}>Use viewport instead</Button>}</div>{error.requestId && <details><summary>Technical details</summary><code>Request ID: {error.requestId}</code></details>}</div>}
    {loading && !preview && <div className="region-preview-loading" role="status" aria-label="Loading region preview"><Spin /><strong>{progressLabels[progress] ?? "Preparing preview"}</strong></div>}
    {preview && <>
      {preview.http_status && preview.http_status >= 400 && <Alert type="warning" showIcon title={`HTTP ${preview.http_status} error page`} description="The preview was captured successfully, but the origin returned an unsuccessful HTTP status." />}
      {preview.warning && <Alert type="warning" showIcon title={preview.warning === "browser_steps_skipped_http_error" ? "Browser steps were skipped because the initial response was an HTTP error page." : `Browser step warning: ${preview.warning}`} />}
      <Typography.Paragraph>Use +/− or pinch to zoom. Drag to pan while zoomed, then click or tap a visible element. The preview uses the current form URL through the normal SSRF, TLS, and sandbox restrictions.</Typography.Paragraph>
      <div className="region-preview-toolbar" aria-label="Preview zoom controls">
        <Button aria-label="Zoom out" onClick={() => changeZoom(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM}>−</Button>
        <output aria-label="Current zoom">{Math.round(zoom * 100)}%</output>
        <Button aria-label="Zoom in" onClick={() => changeZoom(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM}>+</Button>
        <Button onClick={reset}>Fit / Reset</Button>
        {purpose === "step" && <Button onClick={replay} disabled={loading}>Replay preview</Button>}
        {loading && <Spin size="small" aria-label="Resolving selected region" />}
      </div>
      <div ref={canvas} className="region-preview-canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(event) => finishPointer(event, false)} onPointerCancel={(event) => finishPointer(event, true)}>
        <div className="region-preview-stage" style={{ width: `${zoom * 100}%` }}>
          <img ref={previewImage} draggable={false} className="region-preview" src={`data:image/png;base64,${preview.image}`} alt="Secure monitor preview" onLoad={() => setClientTiming((value) => ({ ...value, decode: Math.round(performance.now() - imageDecodeStarted.current) }))} />
          {preview.selection && <span className="region-preview-highlight" aria-hidden="true" style={{ left: `${preview.selection.x / preview.width * 100}%`, top: `${preview.selection.y / preview.height * 100}%`, width: `${preview.selection.width / preview.width * 100}%`, height: `${preview.selection.height / preview.height * 100}%` }} />}
        </div>
      </div>
      {preview.timings && <Typography.Text type="secondary" className="region-preview-timing">Preview ready · server {Object.values(preview.timings).reduce((sum, value) => sum + value, 0)} ms{clientTiming.transfer !== undefined ? ` · transfer ${Math.max(0, clientTiming.transfer)} ms` : ""}{clientTiming.decode !== undefined ? ` · display ${clientTiming.decode} ms` : ""}</Typography.Text>}
      {workflowChanged && <Alert type="info" showIcon title="Step added to the unsaved draft" description="Replay the preview before selecting another element so the screenshot matches the updated workflow." />}
      {preview.selection && <div className="region-preview-selection"><strong>Selected visible element</strong>{(preview.candidates?.length ?? 0) > 1 && <div className="region-preview-candidates" aria-label="Element boundary choices">{preview.candidates!.map((candidate, index) => <Button key={candidate.selector} type={candidate.selector === preview.selection?.selector ? "primary" : "default"} onClick={() => setPreview((current) => current ? { ...current, selection: candidate } : current)}>{candidate.label || (index ? `Parent ${index}` : "Exact element")}</Button>)}</div>}<code>{preview.selection.selector}</code>{purpose === "step" ? <div className="visual-step-builder"><Select aria-label="Browser step action" value={stepAction} onChange={(value) => { setStepAction(value); if (value === "click") setStepOptional(false); }} options={["click", "wait_visible", "wait_selector", "dismiss_cookie", "scroll_to"].map((value) => ({ value, label: value.replaceAll("_", " ") }))} /><InputNumber aria-label="Browser step timeout" min={100} max={10000} value={stepTimeout} onChange={(value) => setStepTimeout(Number(value ?? 5000))} /><Space><Switch aria-label="Optional browser step" checked={stepOptional} disabled={stepAction === "click"} onChange={setStepOptional} /> Optional</Space><Button type="primary" disabled={workflowChanged} onClick={() => { onAddStep?.({ action: stepAction, selector: preview.selection!.selector, selector_type: "css", timeout_ms: stepTimeout, continue_on_error: stepAction === "click" ? false : stepOptional }); setWorkflowChanged(true); }}>Add step to draft</Button></div> : <Button type="primary" onClick={() => { onSelect(preview.selection!.selector); releaseSession(); setOpen(false); }}>Use selector</Button>}</div>}
    </>}
  </>;
  useEffect(() => { if (mobilePage) void load(); }, [mobilePage]);
  if (mobilePage) return <section className="mobile-region-picker-page" aria-label={purpose === "step" ? "Add browser step from preview" : "Select screenshot region"}><div className="mobile-editor-header"><Button type="text" onClick={() => { releaseSession(); onBackMobile?.(); }}>← Back</Button><Typography.Title level={4}>{purpose === "step" ? "Add browser step" : "Select screenshot region"}</Typography.Title></div><div className="mobile-region-picker-body">{previewBody}</div></section>;
  return <>
    <Button onClick={() => { if (compact && onRequestMobile) return onRequestMobile(); setOpen(true); reset(); void load(); }}>{purpose === "step" ? "Add step from Preview" : "Select region visually"}</Button>
    {!compact && <Modal className="region-preview-modal" title={purpose === "step" ? "Add browser step from Preview" : "Select screenshot region"} open={open} onCancel={() => { releaseSession(); setOpen(false); }} footer={null} width={900} destroyOnHidden>{previewBody}</Modal>}
  </>;
}
