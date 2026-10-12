import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Spin, Typography } from "antd";
import { ApiError, api } from "./api";

type Rule = { version: 1; kind: "bounded_context"; before: string; after: string; max_length: number };
type PreviewItem = { index: number; text: string };
type Preview = { session_id: string; items?: PreviewItem[]; matching_line_count?: number; total_line_count?: number; offset?: number; has_more?: boolean; rule?: Rule; extracted?: string; description?: string };

// Turkish-aware case folding keeps the original string offsets intact so
// highlights never need unsafe HTML or approximate index conversion.
const searchKey = (value: string) => value.toLocaleLowerCase("tr-TR");
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const source = searchKey(text), needle = searchKey(query), parts: React.ReactNode[] = [];
  let cursor = 0, match = source.indexOf(needle);
  while (match >= 0) {
    if (match > cursor) parts.push(text.slice(cursor, match));
    parts.push(<mark key={`${match}-${parts.length}`}>{text.slice(match, match + needle.length)}</mark>);
    cursor = match + needle.length;
    match = source.indexOf(needle, cursor);
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function TextPicker({ monitorId, getDraft, onApply, mobilePage = false, onRequestMobile, onBackMobile }: {
  monitorId?: string;
  getDraft: () => { url?: string; text_source?: string };
  onApply: (rule: Rule) => void;
  mobilePage?: boolean;
  onRequestMobile?: () => void;
  onBackMobile?: () => void;
}) {
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [preview, setPreview] = useState<Preview>(), [lineIndex, setLineIndex] = useState<number>(), [value, setValue] = useState(""), [query, setQuery] = useState("");
  const searchRequest = useRef(0);
  useEffect(() => { const media = matchMedia("(max-width: 767px)"); const update = () => setCompact(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const load = async () => {
    const draft = getDraft();
    if (!draft.url || draft.text_source !== "jina") { setError("Choose Jina Reader and enter a valid URL before opening text preview."); return; }
    setLoading(true); setError(""); setLineIndex(undefined); setValue(""); setQuery("");
    try { setPreview(await api("/text-preview", "POST", { monitor_id: monitorId, url: draft.url }, { timeoutMs: 90000 })); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : "Text preview failed. Retry."); }
    finally { setLoading(false); }
  };
  const search = async (nextQuery: string, offset = 0, append = false) => {
    if (!preview?.session_id) return;
    const request = ++searchRequest.current;
    setLoading(true); setError("");
    try {
      const result = await api<Preview>("/text-preview", "POST", { session_id: preview.session_id, query: nextQuery, offset, limit: 100 });
      if (request !== searchRequest.current) return;
      setPreview((current) => current ? { ...current, ...result, items: append ? [...(current.items ?? []), ...(result.items ?? [])] : result.items, rule: undefined, extracted: undefined, description: undefined } : result);
    } catch (cause) { if (request === searchRequest.current) setError(cause instanceof ApiError ? cause.message : "Reader search failed. Retry."); }
    finally { if (request === searchRequest.current) setLoading(false); }
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
    {preview?.items && <><div className="text-picker-search"><Input.Search aria-label="Search Reader output" placeholder="Search available Reader output" value={query} onChange={(event) => { const next = event.target.value; setQuery(next); setLineIndex(undefined); setValue(""); void search(next); }} allowClear />{query && <Button onClick={() => { setQuery(""); setLineIndex(undefined); setValue(""); void search(""); }}>Clear search</Button>}</div><Typography.Text className="text-picker-search-status" aria-live="polite">{preview.matching_line_count ?? 0} matching {(preview.matching_line_count ?? 0) === 1 ? "line" : "lines"} in {preview.total_line_count ?? 0} available Reader lines{preview.has_more ? ` · showing ${preview.items.length}` : ""}</Typography.Text>{preview.items.length ? <><div className="text-preview-lines" role="list" aria-label="Reader text preview">{preview.items.map(({ text, index }) => <button type="button" role="listitem" className={lineIndex === index ? "selected" : ""} key={`${index}-${text.slice(0, 30)}`} onClick={() => { setLineIndex(index); setValue(text); setPreview((current) => current ? { ...current, rule: undefined, extracted: undefined, description: undefined } : current); }}><Highlight text={text} query={query} /></button>)}</div>{preview.has_more && <Button loading={loading} onClick={() => void search(query, preview.items!.length, true)}>Load more matches</Button>}</> : <div className="text-picker-empty" role="status">No matches in the available Reader output.</div>}</>}
    {lineIndex !== undefined && <div className="text-picker-selection"><Typography.Text strong>Selected text or changing value</Typography.Text><Input.TextArea value={value} onChange={(event) => { setValue(event.target.value); setPreview((current) => current ? { ...current, rule: undefined, extracted: undefined, description: undefined } : current); }} maxLength={500} autoSize={{ minRows: 2, maxRows: 5 }} /><Button loading={loading} onClick={() => void generate()}>Generate extraction rule</Button></div>}
    {preview?.rule && <div className="text-picker-result" role="status"><strong>Extracted preview</strong><p>{preview.extracted}</p><Typography.Text type="secondary">{preview.description}</Typography.Text><Button type="primary" onClick={() => { onApply(preview.rule!); setOpen(false); }}>Apply selection</Button></div>}
  </div>;
  useEffect(() => { if (mobilePage) void load(); }, [mobilePage]);
  if (mobilePage) return <section className="mobile-text-picker-page" aria-label="Select Reader text"><div className="mobile-editor-header"><Button type="text" onClick={onBackMobile}>← Back</Button><Typography.Title level={4}>Select Reader text</Typography.Title></div>{body}</section>;
  return <><Button onClick={() => { if (compact && onRequestMobile) return onRequestMobile(); setOpen(true); void load(); }}>Select text from preview</Button>{!compact && <Modal title="Select Reader text" open={open} onCancel={() => setOpen(false)} footer={null} width={850} destroyOnHidden>{body}</Modal>}</>;
}
