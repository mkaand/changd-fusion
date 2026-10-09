import { useState, useEffect } from "react";
import {
  Alert,
  Card,
  Empty,
  Select,
  Space,
  Tag,
  Typography,
  Slider,
  Spin,
} from "antd";
import { api, percent } from "./api";
export function ImageComparison({
  before,
  after,
}: {
  before: string;
  after: string;
}) {
  const [position, setPosition] = useState(50);
  const url = (name: string) => "/api/v1/screenshots/" + name;
  return (
    <>
      <div className="compare">
        <img src={url(before)} alt="Before capture" />
        <img
          className="after"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          src={url(after)}
          alt="After capture"
        />
        <div className="divider" style={{ left: position + "%" }} />
      </div>
      <Slider
        aria-label="Before / After comparison"
        value={position}
        onChange={setPosition}
      />
      <Space>
        Before <span>↔</span> After
      </Space>
    </>
  );
}
export function History({ id, refresh }: { id: string; refresh: number }) {
  const [events, setEvents] = useState<any[]>([]),
    [filter, setFilter] = useState<string | undefined>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api("/jobs/" + id + "/history" + (filter ? "?status=" + filter : ""))
      .then((r) => {
        if (alive) {
          setEvents(r);
          setError("");
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id, filter, refresh]);
  return (
    <>
      <Space className="history-header">
        <Typography.Title level={3}>Monitoring history</Typography.Title>
        <Select
          aria-label="History filter"
          placeholder="All events"
          allowClear
          onChange={setFilter}
          style={{ width: 180 }}
          options={[
            "changed",
            "unchanged",
            "failed",
            "baseline",
            "reset",
            "test",
            "legacy",
          ].map((value) => ({ value, label: value }))}
        />
      </Space>
      {error && <Alert title={error} type="error" />}
      {loading ? (
        <Spin />
      ) : events.length === 0 ? (
        <Empty description="No captures yet. The worker will start the baseline capture." />
      ) : (
        events.map((e) => (
          <Card key={e.id} className="event">
            <Space wrap>
              <Tag
                color={
                  e.status === "failed"
                    ? "red"
                    : e.status === "changed"
                      ? "orange"
                      : "green"
                }
              >
                {e.status}
              </Tag>
              <span>{new Date(e.created_at).toLocaleString()}</span>
              {e.visual_percent !== null && (
                <Tag>Visual: {percent(e.visual_percent)}</Tag>
              )}
              {e.text_changed && <Tag color="blue">Text changed</Tag>}
            </Space>
            {e.error && <Alert title={e.error} type="error" />}
            {e.text_diff?.length > 0 && (
              <pre className="text-diff">
                {e.text_diff.map((p: any, i: number) =>
                  p.added ? (
                    <ins key={i}>{p.value}</ins>
                  ) : p.removed ? (
                    <del key={i}>{p.value}</del>
                  ) : (
                    <span key={i}>{p.value}</span>
                  ),
                )}
              </pre>
            )}
            {e.before_image && e.after_image ? (
              <ImageComparison before={e.before_image} after={e.after_image} />
            ) : (
              e.after_image && (
                <img
                  className="capture"
                  src={"/api/v1/screenshots/" + e.after_image}
                  alt="Baseline capture"
                />
              )
            )}
            {e.diff_screenshot && (
              <details>
                <summary>Difference image</summary>
                <img
                  className="capture"
                  src={"/api/v1/screenshots/" + e.diff_screenshot}
                  alt="Visual differences"
                />
              </details>
            )}
            {e.deliveries?.length > 0 && (
              <Space wrap>
                {e.deliveries.map((d: any) => (
                  <Tag key={d.channel_id}>
                    {d.status} · {d.attempts} attempts
                    {d.error ? " · " + d.error : ""}
                  </Tag>
                ))}
              </Space>
            )}
            {e.status === "legacy" && (
              <Typography.Paragraph type="secondary">
                Imported history. Legacy artifact references are preserved in
                the database.
              </Typography.Paragraph>
            )}
          </Card>
        ))
      )}
    </>
  );
}
