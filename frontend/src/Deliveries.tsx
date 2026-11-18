import { useEffect, useState } from "react";
import { Alert, Button, Card, Table, Tag, Select, Space, Pagination } from "antd";
import { api } from "./api";

const deliverySubject = (item: any) => item.kind === "test" ? "Channel test" : item.monitor_name;
const deliveryDetails = (item: any) => item.last_error ||
  (item.smtp_result?.status === "accepted_by_smtp" && item.accepted_at
    ? `Accepted by SMTP relay ${new Date(item.accepted_at).toLocaleString()} (SMTP ${item.smtp_result.response_code}; inbox delivery unconfirmed)`
    : item.delivered_at
      ? item.provider === "smtp"
        ? `Previously marked sent ${new Date(item.delivered_at).toLocaleString()} (SMTP acceptance was not recorded; inbox delivery unconfirmed)`
        : `Sent to provider ${new Date(item.delivered_at).toLocaleString()}`
      : `Next attempt ${new Date(item.next_attempt).toLocaleString()}`);

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
    [initialLoading, setInitialLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false),
    [version, setVersion] = useState(0);
  const compact = useCompactDeliveries();
  const refresh = () => setVersion((v) => v + 1);
  const retry = async (item: any) => {
    try {
      await api(`/deliveries/${item.id}/retry`, "POST", {});
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    let alive = true;
    const isInitial = items.length === 0;
    if (isInitial) setInitialLoading(true);
    else setRefreshing(true);
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
        if (alive) {
          setInitialLoading(false);
          setRefreshing(false);
        }
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
        <Button loading={refreshing} onClick={refresh}>
          Refresh deliveries
        </Button>
      </Space>
      {error && (
        <Alert
          type="error"
          title={error}
          action={
            <Button onClick={refresh}>Retry</Button>
          }
        />
      )}
      {compact ? (
        <div className="delivery-card-list" aria-label="Notification deliveries">
          {items.map((item) => (
            <Card key={item.id} className="delivery-card" size="small">
              <Space wrap>
                {item.kind === "test" ? <strong>{deliverySubject(item)}</strong> : <a href={`/jobs/${item.monitor_id}`}>{deliverySubject(item)}</a>}
                <Tag>{item.channel_name}</Tag>
                <Tag color={item.status === "failed" ? "red" : item.status === "sent" ? "green" : "blue"}>
                  {item.smtp_result?.status === "accepted_by_smtp" ? "Accepted by SMTP" : item.status}
                </Tag>
              </Space>
              <p className="delivery-details">
                Attempts: {item.attempts} · {deliveryDetails(item)}
              </p>
              {admin && <Button disabled={item.status !== "failed"} onClick={() => void retry(item)}>Retry delivery</Button>}
            </Card>
          ))}
        </div>
      ) : (
      <Table
        className="delivery-table"
        rowKey="id"
        loading={initialLoading}
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
              r.kind === "test" ? <strong>{deliverySubject(r)}</strong> : <a href={"/jobs/" + r.monitor_id}>{deliverySubject(r)}</a>
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
                {r.smtp_result?.status === "accepted_by_smtp" ? "Accepted by SMTP" : r.status}
              </Tag>
            ),
          },
          { title: "Attempts", dataIndex: "attempts" },
          {
            title: "Details",
            render: (_, r) => deliveryDetails(r),
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
