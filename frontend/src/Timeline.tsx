import { useEffect, useState } from "react";
import { Alert, Button, Card, Empty, Input, Pagination, Select, Space, Spin, Table, Tag, Typography } from "antd";
import { api, percent } from "./api";

const statuses = ["baseline", "unchanged", "changed", "failed", "reset", "legacy", "test", "digest", "extraction_transition"];
const tagColor = (status: string) => status === "failed" ? "red" : status === "changed" ? "orange" : status === "baseline" ? "blue" : "green";
const day = (date: Date) => date.toISOString().slice(0, 10);
function useCompact() {
  const [compact, setCompact] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}
export function Timeline({ monitors }: { monitors: any[] }) {
  const compact = useCompact();
  const [items, setItems] = useState<any[]>([]), [total, setTotal] = useState(0), [page, setPage] = useState(1);
  const [monitor, setMonitor] = useState<string>(), [status, setStatus] = useState<string>();
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(() => day(new Date()));
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ page: String(page), page_size: "25" });
    if (from) params.set("from", new Date(from + "T00:00:00.000Z").toISOString());
    if (to) params.set("to", new Date(to + "T23:59:59.999Z").toISOString());
    if (monitor) params.set("monitor_id", monitor);
    if (status) params.set("status", status);
    setLoading(true);
    api<any>("/timeline?" + params).then((result) => {
      if (!alive) return;
      setItems(result.items); setTotal(result.total); setError("");
    }).catch((e: Error) => alive && setError(e.message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [page, monitor, status, from, to, retry]);
  const filters = <Space className="timeline-filters" wrap>
    <Select aria-label="Filter timeline by monitor" allowClear placeholder="All monitors" value={monitor} onChange={(v) => { setMonitor(v); setPage(1); }} options={monitors.map((m) => ({ value: m.id, label: m.name }))} />
    <Select aria-label="Filter timeline by status" allowClear placeholder="All statuses" value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={statuses.map((value) => ({ value, label: value.replaceAll("_", " ") }))} />
    <label>From <Input aria-label="Timeline start date" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label>
    <label>To <Input aria-label="Timeline end date" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label>
  </Space>;
  const event = (item: any) => <>
    <Space wrap><Tag color={tagColor(item.status)}>{item.status.replaceAll("_", " ")}</Tag>{item.text_changed && <Tag color="blue">Text changed</Tag>}{item.text_added && <Tag color="green">Added</Tag>}{item.text_removed && <Tag color="volcano">Removed</Tag>}{item.visual_changed && <Tag>Visual {percent(item.visual_percent)}</Tag>}{item.dimension_changed && <Tag>Dimensions changed</Tag>}</Space>
    {item.status === "failed" && <Typography.Text type="secondary">{item.failure_stage ? `${item.failure_stage} · ` : ""}{item.failure_code ?? "capture failed"}</Typography.Text>}
  </>;
  return <section className="timeline-page" aria-label="Monitoring timeline">
    <div className="dashboard-breadcrumb">Timeline <span>/</span> Monitoring events</div>
    <Space className="page-header dashboard-header" wrap><Typography.Title level={2}>Timeline</Typography.Title><span className="dashboard-caption">Capture events across your monitors</span></Space>
    <Card className="timeline-card">{filters}
      {error && <Alert type="error" title={error} action={<Button onClick={() => setRetry((value) => value + 1)}>Retry</Button>} />}
      {loading ? <div role="status" aria-label="Loading timeline"><Spin /></div> : items.length === 0 ? <Empty description="No monitoring events match these filters." /> : compact ? <div className="timeline-list">{items.map((item) => <Card size="small" key={item.id} className="timeline-event"><Typography.Text strong>{item.monitor_name}</Typography.Text>{event(item)}<Typography.Text type="secondary">{new Date(item.created_at).toLocaleString()}</Typography.Text></Card>)}</div> : <Table rowKey="id" size="small" bordered pagination={false} dataSource={items} columns={[
        { title: "Monitor", dataIndex: "monitor_name", width: 190 },
        { title: "Event", width: 230, render: (_, item) => event(item) },
        { title: "Status", dataIndex: "notification_state", width: 150, render: (value) => value ? <Typography.Text type="secondary">{value.replaceAll("_", " ")}</Typography.Text> : "—" },
        { title: "Occurred", dataIndex: "created_at", width: 210, render: (value) => <span className="numeric">{new Date(value).toLocaleString()}</span> },
      ]} />}
      {!loading && total > 25 && <Pagination current={page} pageSize={25} total={total} showSizeChanger={false} onChange={setPage} />}
    </Card>
  </section>;
}
