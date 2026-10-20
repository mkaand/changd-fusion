import { useEffect, useState } from "react";
import { Alert, Button, Card, Descriptions, Form, InputNumber, Modal, Segmented, Select, Space, Spin, Switch, Tag, Typography } from "antd";
import { Channels } from "./Channels";
import { Deliveries } from "./Deliveries";
import { AccountSecurity } from "./AccountSecurity";
import { ApiError, api } from "./api";
import type { ThemeAdapter } from "./theme";
import { AllMyThemeControls } from "./AllMyThemeControls";
import { buildMetadata, commitUrl, normalizeBuildMetadata, pullRequestUrl, type BuildMetadataInput } from "./build-metadata";

export function Settings({ channels, monitors, reload, report, admin, signedOut, theme, buildMetadata: metadataOverride }: any) {
  const [section, setSection] = useState("general");
  const [diagnostics, setDiagnostics] = useState<any>();
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [error, setError] = useState("");
  const [defaults, setDefaults] = useState<any>({});
  const [defaultForm] = Form.useForm();
  const [bulk, setBulk] = useState(false);
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const [bulkChannel, setBulkChannel] = useState<string>();
  const [bulkAction, setBulkAction] = useState("add");
  const metadata = normalizeBuildMetadata((metadataOverride ?? buildMetadata) as BuildMetadataInput);
  useEffect(() => { api("/preferences/monitoring").then((d) => { setDefaults(d); defaultForm.setFieldsValue(d); }).catch(() => {}); }, [defaultForm]);
  const diagnosticsMessage = (cause: unknown) => {
    if (cause instanceof ApiError) {
      if (cause.status === 403) return "Diagnostics access is not permitted.";
      if (cause.status === 502 || (cause.status ?? 0) >= 500) return "Diagnostics is temporarily unavailable. Retry.";
      return cause.message || "Diagnostics could not be loaded. Retry.";
    }
    if (cause instanceof DOMException && cause.name === "TimeoutError") return "Diagnostics request timed out. Retry.";
    return "Diagnostics could not be loaded. Retry.";
  };
  const loadDiagnostics = async () => {
    setDiagnosticsLoading(true);
    try {
      const value = await api("/system/diagnostics");
      setDiagnostics(value);
      setError("");
    } catch (cause) {
      setError(diagnosticsMessage(cause));
    } finally {
      setDiagnosticsLoading(false);
    }
  };
  useEffect(() => {
    if (section !== "system") return;
    void loadDiagnostics();
  }, [section]);
  return <section className="settings-page" aria-label="Settings">
    <Typography.Title level={2}>Settings</Typography.Title>
    <Segmented block value={section} onChange={setSection} options={[
      { value: "general", label: "General" }, { value: "notifications", label: "Notifications" },
      { value: "monitoring", label: "Monitoring" }, { value: "security", label: "Security" },
      { value: "system", label: "System & Diagnostics" },
    ]} />
    {section === "general" && <Space direction="vertical" size="middle" className="settings-stack">
      <Card title="Appearance"><Space wrap><AllMyThemeControls adapter={theme as ThemeAdapter} /><span>Theme: {theme.preference} ({theme.resolved})</span></Space></Card>
      <Card title="Application" className="application-metadata"><dl className="application-metadata-list">
        <div><dt>Version</dt><dd><span className="application-metadata-token">{metadata.version ?? "Unavailable"}</span></dd></div>
        <div><dt>Branch</dt><dd><span className={metadata.branch ? "application-metadata-value" : "application-metadata-token"}>{metadata.branch ?? "Unavailable"}</span></dd></div>
        <div><dt>Commit HEAD</dt><dd>{metadata.commit ? <Typography.Link className="application-metadata-value" href={commitUrl(metadata.commit)} target="_blank" rel="noreferrer" title={metadata.commit} aria-label={`Commit ${metadata.commit}`}>{metadata.commit.slice(0, 12)}</Typography.Link> : <span className="application-metadata-token">Unavailable</span>}</dd></div>
        <div><dt>Source PR</dt><dd>{metadata.sourcePr ? <Typography.Link href={pullRequestUrl(metadata.sourcePr)} target="_blank" rel="noreferrer">#{metadata.sourcePr}</Typography.Link> : <span className="application-metadata-token">Unavailable</span>}</dd></div>
        <div><dt>Display timezone</dt><dd><span className="application-metadata-token">Browser locale</span></dd></div>
      </dl></Card>
    </Space>}
    {section === "notifications" && <><Channels channels={channels} monitors={monitors} reload={reload} report={report} /><Deliveries admin={admin} /></>}
    {section === "monitoring" && <Space direction="vertical" className="settings-stack" size="middle">
      <Card title="Monitoring defaults"><Typography.Paragraph>These defaults apply only when you create a new monitor. Existing monitors, baselines and history are never changed.</Typography.Paragraph>
      <Form form={defaultForm} initialValues={{ capture_timeout_ms: 60000 }} layout="vertical" onFinish={async (v) => { try { const saved = await api("/preferences/monitoring", "PUT", v); setDefaults(saved); report("Monitoring defaults saved"); } catch (e) { report((e as Error).message); } }}>
        <div className="form-row"><Form.Item name="interval_seconds" label="Default check interval"><InputNumber min={30} max={604800} /></Form.Item><Form.Item name="capture_timeout_ms" label="Default capture timeout"><Select style={{minWidth:180}} options={[{value:30000,label:"30 seconds"},{value:45000,label:"45 seconds"},{value:60000,label:"60 seconds (default)"},{value:75000,label:"75 seconds"},{value:90000,label:"90 seconds"}]} /></Form.Item><Form.Item name="capture_mode" label="Default capture mode"><Select style={{minWidth:180}} options={[{value:"viewport",label:"Viewport"},{value:"full_page",label:"Full page"},{value:"element",label:"Selected element"}]} /></Form.Item><Form.Item name="visual_threshold" label="Visual threshold"><InputNumber min={0} max={100} /></Form.Item></div>
        <div className="form-row"><Form.Item name="notification_enabled" label="Notifications enabled" valuePropName="checked"><Switch /></Form.Item><Form.Item name="notification_cooldown_seconds" label="Cooldown"><Select style={{minWidth:140}} options={[{value:0,label:"Off"},{value:300,label:"5 minutes"},{value:900,label:"15 minutes"},{value:3600,label:"1 hour"},{value:86400,label:"24 hours"}]} /></Form.Item><Form.Item name="notification_mode" label="Mode"><Select style={{minWidth:140}} options={[{value:"immediate",label:"Immediate"},{value:"digest",label:"Digest"}]} /></Form.Item></div>
        <Form.Item name="channel_ids" label="Default notification channels"><Select mode="multiple" options={channels.filter((c:any)=>c.enabled).map((c:any)=>({value:c.id,label:c.name}))} /></Form.Item><Button htmlType="submit">Save defaults</Button>
      </Form><Space wrap><Tag>{monitors.length} monitors</Tag><Tag>{channels.filter((c: any) => c.enabled).length} enabled channels</Tag><Button onClick={() => setBulk(true)}>Bulk notification assignment</Button></Space></Card>
      <Modal title="Bulk notification assignment" open={bulk} onCancel={() => setBulk(false)} okText="Confirm change" okButtonProps={{disabled:!bulkIds.length || !bulkChannel}} onOk={async()=>{try { await api("/monitors/notification-channels/bulk","POST",{monitor_ids:bulkIds,channel_id:bulkChannel,action:bulkAction,confirm:true}); report("Notification channels updated"); setBulk(false); await reload(); }catch(e){report((e as Error).message)}}}><Typography.Paragraph>This changes channel associations only. URLs, captures, baselines, browser steps and history remain unchanged.</Typography.Paragraph><Select mode="multiple" style={{width:"100%"}} placeholder="Select monitors" value={bulkIds} onChange={setBulkIds} options={monitors.map((m:any)=>({value:m.id,label:m.name}))}/><Select style={{width:"100%",marginTop:12}} placeholder="Select channel" value={bulkChannel} onChange={setBulkChannel} options={channels.map((c:any)=>({value:c.id,label:c.name}))}/><Select style={{width:"100%",marginTop:12}} value={bulkAction} onChange={setBulkAction} options={[{value:"add",label:"Add selected channel"},{value:"remove",label:"Remove selected channel"},{value:"replace",label:"Replace all channels"}]}/></Modal>
    </Space>}
    {section === "security" && <Card title="Account security"><Typography.Paragraph>Password changes and sign-out-all revoke active sessions.</Typography.Paragraph><AccountSecurity signedOut={signedOut} /></Card>}
    {section === "system" && <Card title="System & Diagnostics">
      {error && <Alert type="error" title={error} action={<Button size="small" onClick={() => void loadDiagnostics()}>Retry</Button>} />}
      {diagnosticsLoading && !diagnostics ? <span role="status" aria-label="Loading diagnostics"><Spin /></span> : !diagnostics ? (error ? null : <Alert type="info" title="Diagnostics are unavailable. Retry when the service is ready." />) : <Descriptions column={1} items={[
        { key: "api", label: "API", children: <Tag color="green">{diagnostics.api}</Tag> },
        { key: "monitors", label: "Monitoring", children: String(diagnostics.monitoring.active) + "/" + String(diagnostics.monitoring.total) + " active · " + String(diagnostics.monitoring.attention) + " need attention" },
        { key: "delivery", label: "Delivery queue", children: String(diagnostics.deliveries.pending) + " pending · " + String(diagnostics.deliveries.failed) + " failed" },
        { key: "retention", label: "History retention", children: String(diagnostics.retention_days) + " days" },
      ]} />}
    </Card>}
  </section>;
}
