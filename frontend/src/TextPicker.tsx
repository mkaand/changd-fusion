import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Spin, Typography } from "antd";
import { ApiError, api } from "./api";

type Rule = { version: 1; kind: "bounded_context"; before: string; after: string; max_length: number };
type Preview = { session_id: string; lines?: string[]; rule?: Rule; extracted?: string; description?: string };

export function TextPicker({ monitorId, getDraft, onApply, mobilePage = false, onRequestMobile, onBackMobile }: {
  monitorId?: string;
  getDraft: () => { url?: string; text_source?: string };
  onApply: (rule: Rule) => void;
  mobilePage?: boolean;
  onRequestMobile?: () => void;
  onBackMobile?: () => void;
}) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [preview, setPreview] = useState<Preview>(), [lineIndex, setLineIndex] = useState<number>(), [value, setValue] = useState("");
  useEffect(() => { const media = matchMedia("(max-width: 767px)"); const update = () => setCompact(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const load = async () => {
    const draft = getDraft();
    if (!draft.url || draft.text_source !== "jina") { setError("Choose Jina Reader and enter a valid URL before opening text preview."); return; }
    setLoading(true); setError(""); setLineIndex(undefined); setValue("");
    try { setPreview(await api("/text-preview", "POST", { monitor_id: monitorId, url: draft.url }, { timeoutMs: 90000 })); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : "Text preview failed. Retry."); }
    finally { setLoading(false); }
  };
  const generate = async () => {
    if (!preview || lineIndex === undefined) return;
    setLoading(true); setError("");
    try { const generated = await api<Preview>("/text-preview", "POST", { session_id: preview.session_id, line_index: lineIndex, selected_value: value }); setPreview((current) => ({ ...current!, ...generated })); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : "A stable extraction rule could not be generated."); }
    finally { setLoading(false); }
  };
  const body = <div className="text-picker-body">
    <Alert type="info" showIcon title="Select the content you want to monitor" description="This is the current normalized Jina Reader output. Remote Markdown is displayed as plain text and is never executed." />
    {error && <Alert type="error" showIcon title={error} action={<Button onClick={() => void load()}>Refresh preview</Button>} />}
    {loading && !preview && <div className="region-preview-loading"><Spin /><strong>Loading Reader output</strong></div>}
    {preview?.lines && <div className="text-preview-lines" role="list" aria-label="Reader text preview">{preview.lines.map((line, index) => <button type="button" role="listitem" className={lineIndex === index ? "selected" : ""} key={`${index}-${line.slice(0, 30)}`} onClick={() => { setLineIndex(index); setValue(line); setPreview((current) => current ? { session_id: current.session_id, lines: current.lines } : current); }}>{line}</button>)}</div>}
    {lineIndex !== undefined && <div className="text-picker-selection"><Typography.Text strong>Selected text or changing value</Typography.Text><Input.TextArea value={value} onChange={(event) => { setValue(event.target.value); setPreview((current) => current ? { session_id: current.session_id, lines: current.lines } : current); }} maxLength={500} autoSize={{ minRows: 2, maxRows: 5 }} /><Button loading={loading} onClick={() => void generate()}>Generate extraction rule</Button></div>}
    {preview?.rule && <div className="text-picker-result" role="status"><strong>Extracted preview</strong><p>{preview.extracted}</p><Typography.Text type="secondary">{preview.description}</Typography.Text><Button type="primary" onClick={() => { onApply(preview.rule!); setOpen(false); }}>Apply selection</Button></div>}
  </div>;
  useEffect(() => { if (mobilePage) void load(); }, [mobilePage]);
  if (mobilePage) return <section className="mobile-text-picker-page" aria-label="Select Reader text"><div className="mobile-editor-header"><Button type="text" onClick={onBackMobile}>← Back</Button><Typography.Title level={4}>Select Reader text</Typography.Title></div>{body}</section>;
  return <><Button onClick={() => { if (compact && onRequestMobile) return onRequestMobile(); setOpen(true); void load(); }}>Select text from preview</Button>{!compact && <Modal title="Select Reader text" open={open} onCancel={() => setOpen(false)} footer={null} width={850} destroyOnHidden>{body}</Modal>}</>;
}
