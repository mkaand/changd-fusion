import { useState } from "react";
import { Alert, Button, Modal, Space, Spin, Typography } from "antd";
import { ApiError, api } from "./api";
const PREVIEW_REQUEST_TIMEOUT_MS = 125000;
type Draft = { url?: string; kind?: string; visual_enabled?: boolean; browser_steps?: unknown[] };
export function RegionPicker({ monitorId, getDraft, onSelect, onUseViewport }: {
  monitorId?: string;
  getDraft: () => Draft;
  onSelect: (selector: string) => void;
  onUseViewport: () => void;
}) {
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<any>(), [loading, setLoading] = useState(false), [error, setError] = useState<ApiError>();
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
  return <>
    <Button onClick={() => { setOpen(true); void load(); }}>Select region visually</Button>
    <Modal className="region-preview-modal" title="Select screenshot region" open={open} onCancel={() => setOpen(false)} footer={null} width={900} destroyOnHidden>
      {error && <Alert type="error" title={error.message} description={error.failureCode ? `Preview: ${error.previewStage ?? "unknown"} · ${error.failureCode}${error.requestId ? ` · Request ${error.requestId}` : ""}` : undefined} action={<Space><Button onClick={() => void load()}>Retry</Button><Button onClick={() => { onUseViewport(); setOpen(false); }}>Use viewport instead</Button></Space>} />}
      {loading && <div className="region-preview-loading" role="status" aria-label="Loading region preview"><Spin /></div>}
      {preview && <>
        <Typography.Paragraph>Click a visible element to generate a selector. The preview uses the current form URL through the normal SSRF, TLS, and sandbox restrictions.</Typography.Paragraph>
        <img className="region-preview" src={`data:image/png;base64,${preview.image}`} alt="Secure monitor preview" onClick={(e) => { const rect = e.currentTarget.getBoundingClientRect(); void load({ x: Math.round((e.clientX - rect.left) * 1280 / rect.width), y: Math.round((e.clientY - rect.top) * 900 / rect.height) }); }} />
        {preview.selection && <Alert type="success" title="Unique visible element selected" description={preview.selection.selector} action={<Button onClick={() => { onSelect(preview.selection.selector); setOpen(false); }}>Use selector</Button>} />}
      </>}
    </Modal>
  </>;
}
