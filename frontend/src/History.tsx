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
  dimensionChanged = false,
}: {
  before: string;
  after: string;
  dimensionChanged?: boolean;
}) {
  const [position, setPosition] = useState(50),
    [failed, setFailed] = useState(false);
  const imageProps = {
    loading: "lazy" as const,
    decoding: "async" as const,
    onError: () => setFailed(true),
  };
  const url = (name: string) => "/api/v1/screenshots/" + name;
  if (dimensionChanged)
    return (
      <div className="dimension-images">
        <figure>
          <figcaption>Before</figcaption>
          <img
            {...imageProps}
            className="capture"
            src={url(before)}
            alt="Before capture"
          />
        </figure>
        <figure>
          <figcaption>After</figcaption>
          <img
            {...imageProps}
            className="capture"
            src={url(after)}
            alt="After capture"
          />
        </figure>
        {failed && (
          <Alert
            title="An image is unavailable. Refresh history to try again."
            type="warning"
          />
        )}
      </div>
    );
  return (
    <>
      {failed && (
        <Alert
          title="An image is unavailable. Refresh history to try again."
          type="warning"
        />
      )}
      <div className="compare">
        <img {...imageProps} src={url(before)} alt="Before capture" />
        <img
          {...imageProps}
          className="after"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          src={url(after)}
          alt="After capture"
        />
        <div className="divider" style={{ left: position + "%" }} />
      </div>
      <Slider
        ariaLabelForHandle="Before / After comparison"
        ariaValueTextFormatterForHandle={(value) =>
          `${value}% after, ${100 - value}% before`
        }
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
        <div role="status" aria-label="Loading monitoring history">
          <Spin />
        </div>
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
            {e.dimension_changed && (
              <Alert
                showIcon
                type="info"
                title="Screenshot dimensions changed"
                description={`${e.before_dimensions?.width}×${e.before_dimensions?.height} → ${e.after_dimensions?.width}×${e.after_dimensions?.height}. Pixel percentage is unavailable. The new capture becomes the baseline.`}
              />
            )}
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
              <ImageComparison
                before={e.before_image}
                after={e.after_image}
                dimensionChanged={e.dimension_changed}
              />
            ) : (
              e.after_image && (
                <img
                  className="capture"
                  loading="lazy"
                  decoding="async"
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
                  loading="lazy"
                  decoding="async"
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
