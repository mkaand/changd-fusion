import { useState, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
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
  Pagination,
  Button,
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
  const activePointer = useRef<number | null>(null);
  const moveDivider = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) {
      setPosition(Math.max(0, Math.min(100, Math.round((event.clientX - rect.left) * 100 / rect.width))));
    }
  };
  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    activePointer.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    moveDivider(event);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
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
            title="An image is unavailable. Reload the page to try again."
            type="warning"
          />
        )}
      </div>
    );
  return (
    <>
      {failed && (
        <Alert
          title="An image is unavailable. Reload the page to try again."
          type="warning"
        />
      )}
      <div
        className="compare"
        role="group"
        aria-label="Drag to compare before and after"
        onPointerDown={beginDrag}
        onPointerMove={(event) => { if (activePointer.current === event.pointerId) moveDivider(event); }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <img {...imageProps} src={url(before)} alt="Before capture" draggable={false} />
        <img
          {...imageProps}
          className="after"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          src={url(after)}
          alt="After capture"
          draggable={false}
        />
        <span className="comparison-side comparison-side-before" aria-hidden="true">Before</span>
        <span className="comparison-side comparison-side-after" aria-hidden="true">After</span>
        <div className="divider" style={{ left: position + "%" }} aria-hidden="true">
          <span className="comparison-handle">↔</span>
        </div>
      </div>
      <Slider
        ariaLabelForHandle="Before / After comparison"
        ariaValueTextFormatterForHandle={(value) =>
          `${value}% after, ${100 - value}% before`
        }
        value={position}
        onChange={setPosition}
      />
      <Typography.Text type="secondary">Drag the divider on the image, or use the keyboard-accessible slider.</Typography.Text>
    </>
  );
}
export function History({ id, refresh }: { id: string; refresh: number }) {
  const [events, setEvents] = useState<any[]>([]),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [retry, setRetry] = useState(0),
    [filter, setFilter] = useState<string | undefined>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(
      "/jobs/" +
        id +
        "/history?page=" +
        page +
        "&page_size=20" +
        (filter ? "&status=" + filter : ""),
    )
      .then((r) => {
        if (alive) {
          setEvents(r.items);
          setTotal(r.total);
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
  }, [id, filter, refresh, page, retry]);
  return (
    <section className="monitor-history" aria-label="Monitoring history">
      <Space className="history-header">
        <Typography.Title level={3}>Monitoring history</Typography.Title>
        <Select
          aria-label="History filter"
          placeholder="All events"
          allowClear
          onChange={(v) => {
            setFilter(v);
            setPage(1);
          }}
          style={{ width: 180 }}
          options={[
            "changed",
            "unchanged",
            "failed",
            "baseline",
            "reset",
            "test",
            "legacy",
            "extraction_transition",
          ].map((value) => ({ value, label: value }))}
        />
      </Space>
      {error && (
        <Alert
          title={error}
          type="error"
          action={<Button onClick={() => setRetry((v) => v + 1)}>Retry</Button>}
        />
      )}
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
                {e.status === "extraction_transition"
                  ? "extraction updated"
                  : e.status}
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
            {e.configuration_changed && (
              <Alert
                type="info"
                title="Capture configuration changed"
                description="Previous images remain in history. The next successful capture establishes the new baseline."
              />
            )}
            {e.status === "extraction_transition" && (
              <Alert
                type="info"
                title="Visible-text extraction updated"
                description="The successful capture became the new text baseline. No change notification was sent."
              />
            )}
            {e.attention_state && (
              <Tag color="red">
                {e.attention_state.replaceAll("_", " ")}{" "}
                {e.warning_code ? "(" + e.warning_code + ")" : ""}
              </Tag>
            )}
            {e.status === "failed" && e.failure_code && (
              <Tag color="volcano">
                {e.failure_stage ? `${e.failure_stage} · ` : ""}
                {e.failure_code}
              </Tag>
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
      <Pagination
        current={page}
        total={total}
        pageSize={20}
        showSizeChanger={false}
        onChange={setPage}
        hideOnSinglePage
      />
    </section>
  );
}
