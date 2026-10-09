import { useCallback, useEffect, useState } from "react";
import {
  Layout,
  Menu,
  Button,
  Card,
  Typography,
  Table,
  Tag,
  Space,
  Modal,
  Form,
  Alert,
  Empty,
  Spin,
  App as AntApp,
} from "antd";
import {
  EyeOutlined,
  BellOutlined,
  LogoutOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { api, percent } from "./api";
import { Login } from "./Login";
import { MonitorForm, defaults } from "./MonitorForm";
import { History } from "./History";
import { Channels } from "./Channels";
import logo from "./assets/logo.svg";
const { Header, Sider, Content } = Layout;
export default function FusionApp() {
  const { message } = AntApp.useApp();
  const [user, setUser] = useState<any>(),
    [authLoading, setAuthLoading] = useState(true),
    [monitors, setMonitors] = useState<any[]>([]),
    [channels, setChannels] = useState<any[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [page, setPage] = useState("jobs"),
    [selected, setSelected] = useState<any>(),
    [refresh, setRefresh] = useState(0),
    [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<any>(),
    [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const getUser = useCallback(async () => {
    try {
      setUser(await api("/users/me"));
    } catch {
      setUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, []);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [m, c] = await Promise.all([api("/jobs"), api("/notifications")]);
      setMonitors(m);
      setChannels(c);
      setError("");
      setRefresh((r) => r + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void getUser();
  }, [getUser]);
  useEffect(() => {
    if (user) void reload();
  }, [user, reload]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => void reload(), 15000);
    return () => clearInterval(timer);
  }, [user, reload]);
  const navigate = (key: string) => {
    setPage(key);
    setSelected(undefined);
    history.replaceState(null, "", key === "jobs" ? "/jobs" : "/notifications");
  };
  const detail = async (id: string) => {
    try {
      setSelected(await api("/jobs/" + id));
      setPage("detail");
      history.replaceState(null, "", "/jobs/" + id);
    } catch (e) {
      void message.error((e as Error).message);
    }
  };
  useEffect(() => {
    if (user && /^\/jobs\/[a-f\d-]{36}$/.test(location.pathname))
      void detail(location.pathname.split("/")[2]);
  }, [user]);
  const edit = async (m?: any) => {
    setEditing(m);
    form.resetFields();
    form.setFieldsValue(
      m ? { ...defaults, ...(await api("/jobs/" + m.id)) } : defaults,
    );
    setOpen(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      const b = await form.validateFields();
      if (!b.text_enabled && !b.visual_enabled)
        throw Error("Enable at least one detection method");
      await api(
        "/jobs" + (editing ? "/" + editing.id : ""),
        editing ? "PUT" : "POST",
        b,
      );
      setOpen(false);
      await reload();
      if (selected) await detail(selected.id);
    } catch (e) {
      if (e instanceof Error) void message.error(e.message);
    } finally {
      setSaving(false);
    }
  };
  const action = async (id: string, name: string) => {
    try {
      await api("/jobs/" + id + "/" + name, "POST", {});
      void message.success(
        name === "run"
          ? "Capture queued"
          : "Baseline reset; next successful capture establishes it",
      );
      await reload();
    } catch (e) {
      void message.error((e as Error).message);
    }
  };
  if (authLoading)
    return (
      <div className="center">
        <Spin />
      </div>
    );
  if (!user) return <Login onSuccess={() => void getUser()} />;
  const current = monitors.find((m) => m.id === selected?.id) ?? selected;
  return (
    <Layout className="shell">
      <Header className="header">
        <a
          href="/jobs"
          onClick={(e) => {
            e.preventDefault();
            navigate("jobs");
          }}
          className="brand"
        >
          <img src={logo} alt="Changd" />
          Changd <span>Fusion</span>
        </a>
        <Space>
          <span className="user-name">{user.firstname || "Account"}</span>
          <Button
            icon={<LogoutOutlined />}
            onClick={async () => {
              await api("/logout", "POST", {});
              setUser(null);
            }}
          >
            Sign out
          </Button>
        </Space>
      </Header>
      <Layout>
        <Sider
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          breakpoint="lg"
          theme="light"
        >
          <Menu
            selectedKeys={[page === "detail" ? "jobs" : page]}
            items={[
              { key: "jobs", icon: <EyeOutlined />, label: "Monitors" },
              {
                key: "notifications",
                icon: <BellOutlined />,
                label: "Notifications",
              },
            ]}
            onClick={({ key }) => navigate(key)}
          />
        </Sider>
        <Content className="content">
          {error && <Alert title={error} type="error" showIcon />}
          {page === "notifications" ? (
            <Channels
              channels={channels}
              monitors={monitors}
              reload={() => void reload()}
              report={(s) => void message.info(s)}
            />
          ) : page === "detail" && current ? (
            <>
              <Button onClick={() => navigate("jobs")}>← Monitors</Button>
              <Space className="page-header" wrap>
                <Typography.Title level={2}>{current.name}</Typography.Title>
                <Button onClick={() => void edit(current)}>Edit</Button>
                <Button
                  type="primary"
                  onClick={() => void action(current.id, "run")}
                >
                  Check now
                </Button>
                <Button onClick={() => void action(current.id, "reset")}>
                  Reset baseline
                </Button>
              </Space>
              <Card>
                <Space wrap>
                  <Tag
                    color={
                      current.last_error
                        ? "red"
                        : current.enabled
                          ? "green"
                          : "default"
                    }
                  >
                    {current.last_error
                      ? "Retrying"
                      : current.enabled
                        ? "Active"
                        : "Paused"}
                  </Tag>
                  {current.text_enabled && <Tag>Text</Tag>}
                  {current.visual_enabled && (
                    <Tag>Visual: {percent(current.last_percent)}</Tag>
                  )}
                  <span>Every {current.interval_seconds}s</span>
                </Space>
                <Typography.Paragraph>{current.url}</Typography.Paragraph>
                {current.last_error && (
                  <Alert title={current.last_error} type="error" />
                )}
                <Typography.Text type="secondary">
                  Baseline advances only after a combined change event. Failed
                  captures preserve the baseline.
                </Typography.Text>
              </Card>
              <History id={current.id} refresh={refresh} />
            </>
          ) : (
            <>
              <Space className="page-header" wrap>
                <Typography.Title level={2}>Monitors</Typography.Title>
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => void edit()}
                >
                  New monitor
                </Button>
                <Button onClick={() => void reload()}>Refresh</Button>
              </Space>
              <Card>
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={monitors}
                  scroll={{ x: 760 }}
                  locale={{
                    emptyText: (
                      <Empty description="Create a monitor to track text and visual changes together." />
                    ),
                  }}
                  columns={[
                    {
                      title: "Monitor",
                      dataIndex: "name",
                      render: (name: string, m: any) => (
                        <Button type="link" onClick={() => void detail(m.id)}>
                          {name}
                        </Button>
                      ),
                    },
                    {
                      title: "Detection",
                      render: (_, m: any) => (
                        <Space>
                          {m.text_enabled && <Tag>Text</Tag>}
                          {m.visual_enabled && <Tag color="blue">Visual</Tag>}
                          {m.kind !== "browser" && <Tag>{m.kind}</Tag>}
                        </Space>
                      ),
                    },
                    {
                      title: "Visual change",
                      dataIndex: "last_percent",
                      render: percent,
                    },
                    {
                      title: "Status",
                      render: (_, m: any) => (
                        <Tag
                          color={
                            m.last_error
                              ? "red"
                              : m.enabled
                                ? "green"
                                : "default"
                          }
                        >
                          {m.last_error
                            ? "Retrying"
                            : m.enabled
                              ? "Active"
                              : "Paused"}
                        </Tag>
                      ),
                    },
                    {
                      title: "Next check",
                      dataIndex: "next_run",
                      render: (s: string) => new Date(s).toLocaleString(),
                    },
                    {
                      title: "Actions",
                      render: (_, m: any) => (
                        <Space>
                          <Button onClick={() => void edit(m)}>Edit</Button>
                          <Button
                            danger
                            onClick={() =>
                              Modal.confirm({
                                title: "Delete monitor and history?",
                                onOk: async () => {
                                  await api("/jobs/" + m.id, "DELETE");
                                  await reload();
                                },
                              })
                            }
                          >
                            Delete
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            </>
          )}
        </Content>
      </Layout>
      <Modal
        open={open}
        title={editing ? "Edit monitor" : "New unified monitor"}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        width={640}
        destroyOnHidden
      >
        <MonitorForm form={form} channels={channels} />
      </Modal>
    </Layout>
  );
}
