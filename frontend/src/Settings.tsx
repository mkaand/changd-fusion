import { useEffect, useState } from "react";
import { Alert, Card, Descriptions, Segmented, Space, Spin, Tag, Typography } from "antd";
import { Channels } from "./Channels";
import { Deliveries } from "./Deliveries";
import { AccountSecurity } from "./AccountSecurity";
import { api } from "./api";
import type { ThemeAdapter } from "./theme";
import { AllMyThemeControls } from "./AllMyThemeControls";

export function Settings({ channels, monitors, reload, report, admin, signedOut, theme }: any) {
  const [section, setSection] = useState("general");
  const [diagnostics, setDiagnostics] = useState<any>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (section !== "system") return;
    let alive = true;
    api("/system/diagnostics").then((value) => alive && (setDiagnostics(value), setError(""))).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
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
      <Card title="Application"><Descriptions column={1} items={[{ key: "version", label: "Version", children: "Changd Fusion Sprint 3" }, { key: "time", label: "Display timezone", children: "Browser locale" }]} /></Card>
    </Space>}
    {section === "notifications" && <><Channels channels={channels} monitors={monitors} reload={reload} report={report} /><Deliveries admin={admin} /></>}
    {section === "monitoring" && <Card title="Monitoring defaults"><Typography.Paragraph>Existing monitors keep their own schedule, capture mode and notification channels. Configure defaults while creating a monitor; bulk changes are intentionally not applied automatically.</Typography.Paragraph><Tag>{monitors.length} monitors</Tag><Tag>{channels.filter((c: any) => c.enabled).length} enabled channels</Tag></Card>}
    {section === "security" && <Card title="Account security"><Typography.Paragraph>Password changes and sign-out-all revoke active sessions.</Typography.Paragraph><AccountSecurity signedOut={signedOut} /></Card>}
    {section === "system" && <Card title="System & Diagnostics">
      {error && <Alert type="error" title={error} />}
      {!diagnostics ? <Spin /> : <Descriptions column={1} items={[
        { key: "api", label: "API", children: <Tag color="green">{diagnostics.api}</Tag> },
        { key: "monitors", label: "Monitoring", children: String(diagnostics.monitoring.active) + "/" + String(diagnostics.monitoring.total) + " active · " + String(diagnostics.monitoring.attention) + " need attention" },
        { key: "delivery", label: "Delivery queue", children: String(diagnostics.deliveries.pending) + " pending · " + String(diagnostics.deliveries.failed) + " failed" },
        { key: "retention", label: "History retention", children: String(diagnostics.retention_days) + " days" },
      ]} />}
    </Card>}
  </section>;
}
