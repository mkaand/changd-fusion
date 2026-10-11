import { useState } from "react";
import { Alert, Button, Modal, Spin } from "antd";
import { api } from "./api";

export function RegionPicker({ monitorId, onSelect }: { monitorId?: string; onSelect: (selector: string) => void }) {
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<any>(), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const load = async (point?: {x:number;y:number}) => { if (!monitorId) return; setLoading(true); try { setPreview(await api(`/jobs/${monitorId}/region-preview`, "POST", point ?? {})); setError(""); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } };
  return <><Button disabled={!monitorId} onClick={() => { setOpen(true); void load(); }}>Select region visually</Button>{!monitorId && <span> Save the monitor first to use a controlled preview.</span>}<Modal title="Select screenshot region" open={open} onCancel={() => setOpen(false)} footer={null} width={900}>{error && <Alert type="error" title={error}/>} {loading && <Spin/>} {preview && <><p>Click a visible element to generate a selector. The preview uses the monitor URL through the normal SSRF and browser sandbox restrictions.</p><img className="region-preview" src={`data:image/png;base64,${preview.image}`} alt="Secure monitor preview" onClick={(e)=>{ const rect=e.currentTarget.getBoundingClientRect(); void load({x:Math.round((e.clientX-rect.left)*1280/rect.width),y:Math.round((e.clientY-rect.top)*900/rect.height)}); }}/>{preview.selection && <Alert type="success" title="Unique visible element selected" description={preview.selection.selector} action={<Button onClick={()=>{onSelect(preview.selection.selector);setOpen(false)}}>Use selector</Button>}/>}</>}</Modal></>;
}
