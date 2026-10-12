import { useEffect, useState } from "react";
import { Alert, Button, Modal, Space, Spin, Typography } from "antd";
import { ApiError, api } from "./api";
const PREVIEW_REQUEST_TIMEOUT_MS = 125000;
type Draft = { url?: string; kind?: string; visual_enabled?: boolean; browser_steps?: unknown[] };
export function RegionPicker({ monitorId, getDraft, onSelect, onUseViewport, mobilePage = false, onRequestMobile, onBackMobile }: {
  monitorId?: string;
  getDraft: () => Draft;
  onSelect: (selector: string) => void;
  onUseViewport: () => void;
  mobilePage?: boolean;
  onRequestMobile?: () => void;
  onBackMobile?: () => void;
}) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<any>(), [loading, setLoading] = useState(false), [error, setError] = useState<ApiError>();
  useEffect(() => { const media = window.matchMedia("(max-width: 767px)"); const update = () => setCompact(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const load = async (point?: { x: number; y: number }) => {
    const draft = getDraft();
    if (!draft.url || draft.kind !== "browser" || !draft.visual_enabled) {
      setError(new ApiError("Enter a valid Browser URL and enable Visual detection before previewing a region."));
      return;
    }
    setLoading(true);
    try {
      setPreview(await api("/region-preview", "POST", { monitor_id: monitorId, monitor: { url: draft.url, kind: "browser", visual_enabled: true, browser_steps: draft.browser_steps ?? [] }, point }, { timeoutMs: PREVIEW_REQUEST_TIMEOUT_MS }));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError("Website preview failed. Retry, or use viewport capture instead."));
    } finally { setLoading(false); }
  };
  const previewBody = <>
      {error && <Alert type="error" title={error.message} description={error.failureCode ? `Preview: ${error.previewStage ?? "unknown"} · ${error.failureCode}${error.requestId ? ` · Request ${error.requestId}` : ""}` : undefined} action={<Space><Button onClick={() => void load()}>Retry</Button><Button onClick={() => { onUseViewport(); setOpen(false); }}>Use viewport instead</Button></Space>} />}
      {loading && <div className="region-preview-loading" role="status" aria-label="Loading region preview"><Spin /></div>}
      {preview && <>
        <Typography.Paragraph>Pinch to zoom or pan, then tap a visible element. The preview uses the current form URL through the normal SSRF, TLS, and sandbox restrictions.</Typography.Paragraph>
        <div className="region-preview-canvas"><img className="region-preview" src={`data:image/png;base64,${preview.image}`} alt="Secure monitor preview" onClick={(e) => { const rect = e.currentTarget.getBoundingClientRect(); void load({ x: Math.round((e.clientX - rect.left) * 1280 / rect.width), y: Math.round((e.clientY - rect.top) * 900 / rect.height) }); }} />
          {preview.selection && <span className="region-preview-highlight" aria-hidden="true" style={{ left: `${preview.selection.x / 1280 * 100}%`, top: `${preview.selection.y / 900 * 100}%`, width: `${preview.selection.width / 1280 * 100}%`, height: `${preview.selection.height / 900 * 100}%` }} />}
        </div>
        {preview.selection && <Alert type="success" title="Unique visible element selected" description={preview.selection.selector} action={<Button onClick={() => { onSelect(preview.selection.selector); setOpen(false); }}>Use selector</Button>} />}
      </>}
    </>;
  useEffect(() => { if (mobilePage) void load(); }, [mobilePage]);
  if (mobilePage) return <section className="mobile-region-picker-page" aria-label="Select screenshot region"><div className="mobile-editor-header"><Button type="text" onClick={onBackMobile}>← Back</Button><Typography.Title level={4}>Select screenshot region</Typography.Title></div><div className="mobile-region-picker-body">{previewBody}</div></section>;
  return <>
    <Button onClick={() => { if (compact && onRequestMobile) return onRequestMobile(); setOpen(true); void load(); }}>Select region visually</Button>
    {!compact && <Modal className="region-preview-modal" title="Select screenshot region" open={open} onCancel={() => setOpen(false)} footer={null} width={900} destroyOnHidden>{previewBody}</Modal>}
  </>;
}
