import { useEffect, useMemo, useState } from "react";
import { Alert, Card, Empty, Input, Select, Space, Spin, Statistic, Table, Tag, Typography } from "antd";
import { api } from "./api";
const statuses = ["baseline", "unchanged", "changed", "failed", "reset", "legacy", "test", "digest", "extraction_transition"];
const day = (date: Date) => date.toISOString().slice(0, 10);
function Trend({ rows }: { rows: any[] }) {
  const points = useMemo(() => {
    if (!rows.length) return "";
    const highest = Math.max(1, ...rows.map((row) => Number(row.total)));
    return rows.map((row, index) => `${rows.length === 1 ? 50 : index / (rows.length - 1) * 100},${92 - Number(row.total) / highest * 80}`).join(" ");
  }, [rows]);
  if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No events in this period." />;
  return <div className="analytics-trend" role="img" aria-label="Daily capture event trend"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points={points} /></svg><div><span>{rows[0].day}</span><span>{rows.at(-1).day}</span></div></div>;
}
export function Analytics({ monitors }: { monitors: any[] }) {
  const [monitor, setMonitor] = useState<string>(), [status, setStatus] = useState<string>();
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 29 * 86400000))), [to, setTo] = useState(() => day(new Date()));
  const [data, setData] = useState<any>(), [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams();
    if (from) params.set("from", new Date(from + "T00:00:00.000Z").toISOString());
    if (to) params.set("to", new Date(to + "T23:59:59.999Z").toISOString());
    if (monitor) params.set("monitor_id", monitor); if (status) params.set("status", status);
    setLoading(true);
    api<any>("/analytics?" + params).then((value) => { if (alive) { setData(value); setError(""); } }).catch((e: Error) => alive && setError(e.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [monitor, status, from, to]);
  return <section className="analytics-page" aria-label="Monitoring analytics">
    <div className="dashboard-breadcrumb">Analytics <span>/</span> Monitoring outcomes</div>
    <Space className="page-header dashboard-header" wrap><Typography.Title level={2}>Analytics</Typography.Title><span className="dashboard-caption">Event distribution and daily trends</span></Space>
    <Space className="timeline-filters" wrap>
      <Select aria-label="Filter analytics by monitor" allowClear placeholder="All monitors" value={monitor} onChange={setMonitor} options={monitors.map((m) => ({ value: m.id, label: m.name }))} />
      <Select aria-label="Filter analytics by status" allowClear placeholder="All statuses" value={status} onChange={setStatus} options={statuses.map((value) => ({ value, label: value.replaceAll("_", " ") }))} />
      <label>From <Input aria-label="Analytics start date" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To <Input aria-label="Analytics end date" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </Space>
    {error && <Alert type="error" title={error} />}
    {loading ? <div role="status" aria-label="Loading analytics"><Spin /></div> : <>
      <div className="analytics-summary"><Card><Statistic title="Events" value={Number(data?.summary?.total ?? 0)} /></Card><Card><Statistic title="Changes" value={Number(data?.summary?.changed ?? 0)} /></Card><Card><Statistic title="Successful captures" value={Number(data?.summary?.successful ?? 0)} /></Card><Card><Statistic title="Failures" value={Number(data?.summary?.failed ?? 0)} /></Card></div>
      <div className="analytics-grid"><Card title="Daily trend"><Trend rows={data?.trend ?? []} /></Card><Card title="Event distribution"><Table rowKey="status" size="small" pagination={false} dataSource={data?.distribution ?? []} locale={{ emptyText: "No event data" }} columns={[{ title: "Status", dataIndex: "status", render: (value) => <Tag color={value === "failed" ? "red" : value === "changed" ? "orange" : "green"}>{value.replaceAll("_", " ")}</Tag> }, { title: "Events", dataIndex: "count", align: "right" }]} /></Card></div>
    </>}
  </section>;
}
