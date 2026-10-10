import { useEffect, useState } from "react";
import { Alert, Button, Card, Table, Tag, Select, Space, Pagination } from "antd";
import { api } from "./api";

function useCompactDeliveries() {
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < 1024,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}

export function Deliveries({ admin = false }: { admin?: boolean }) {
  const [items, setItems] = useState<any[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(1),
    [status, setStatus] = useState<string>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  const compact = useCompactDeliveries();
  const retry = async (item: any) => {
    try {
      await api(`/deliveries/${item.id}/retry`, "POST", {});
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api(
      `/deliveries?page=${page}&page_size=10${status ? "&status=" + status : ""}`,
    )
      .then((r) => {
        if (alive) {
          setItems(r.items);
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
  }, [page, status, version]);
  return (
    <section aria-label="Notification delivery history">
      <h3>Delivery history</h3>
      <Space wrap>
        <Select
          aria-label="Delivery status"
          placeholder="All deliveries"
          allowClear
          style={{ width: 180 }}
          options={["pending", "retrying", "sending", "sent", "failed"].map(
            (value) => ({ value, label: value }),
          )}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        />
        <Button onClick={() => setVersion((v) => v + 1)}>
          Refresh deliveries
        </Button>
      </Space>
      {error && (
        <Alert
          type="error"
          title={error}
          action={
            <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
          }
        />
      )}
      {compact ? (
        <div className="delivery-card-list" aria-label="Notification deliveries">
          {items.map((item) => (
            <Card key={item.id} className="delivery-card" size="small">
              <Space wrap>
                <a href={`/jobs/${item.monitor_id}`}>{item.monitor_name}</a>
                <Tag>{item.channel_name}</Tag>
                <Tag color={item.status === "failed" ? "red" : item.status === "sent" ? "green" : "blue"}>
                  {item.status}
                </Tag>
              </Space>
              <p className="delivery-details">
                Attempts: {item.attempts} · {item.last_error || (item.delivered_at ? "Delivered " + new Date(item.delivered_at).toLocaleString() : "Next attempt " + new Date(item.next_attempt).toLocaleString())}
              </p>
              {admin && <Button disabled={item.status !== "failed"} onClick={() => void retry(item)}>Retry delivery</Button>}
            </Card>
          ))}
        </div>
      ) : (
      <Table
        rowKey="id"
        loading={loading}
        dataSource={items}
        scroll={{ x: 600 }}
        pagination={{
          current: page,
          pageSize: 10,
          total,
          onChange: setPage,
          showSizeChanger: false,
        }}
        columns={[
          {
            title: "Monitor",
            render: (_, r) => (
              <a href={"/jobs/" + r.monitor_id}>{r.monitor_name}</a>
            ),
          },
          { title: "Channel", dataIndex: "channel_name" },
          {
            title: "Status",
            render: (_, r) => (
              <Tag
                color={
                  r.status === "failed"
                    ? "red"
                    : r.status === "sent"
                      ? "green"
                      : "blue"
                }
              >
                {r.status}
              </Tag>
            ),
          },
          { title: "Attempts", dataIndex: "attempts" },
          {
            title: "Details",
            render: (_, r) =>
              r.last_error ||
              (r.delivered_at
                ? "Delivered " + new Date(r.delivered_at).toLocaleString()
                : "Next attempt " + new Date(r.next_attempt).toLocaleString()),
          },
          ...(admin
            ? [
                {
                  title: "Action",
                  render: (_: unknown, r: any) => (
                    <Button
                      disabled={r.status !== "failed"}
                      onClick={() => void retry(r)}
                    >
                      Retry delivery
                    </Button>
                  ),
                },
              ]
            : []),
        ]}
      />
      )}
      {compact && (
        <Pagination
          current={page}
          pageSize={10}
          total={total}
          onChange={setPage}
          showSizeChanger={false}
          hideOnSinglePage
        />
      )}
    </section>
  );
}
