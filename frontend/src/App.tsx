import { useCallback, useEffect, useState, lazy, Suspense } from "react";
import {
  Layout,
  Input,
  Select,
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
  Drawer,
  Dropdown,
  App as AntApp,
} from "antd";
import {
  EyeOutlined,
  BellOutlined,
  SettingOutlined,
  LogoutOutlined,
  PlusOutlined,
  MenuOutlined,
  MoreOutlined,
} from "@ant-design/icons";
import { api, percent } from "./api";
import { monitorState, monitorStates, filterMonitors } from "./monitor-status";
import { useThemeAdapter } from "./theme";
import { AllMyThemeControls } from "./AllMyThemeControls";
import { Login } from "./Login";
import { MonitorForm, defaults } from "./MonitorForm";
import { MonitorUrlActions } from "./MonitorUrlActions";
const History = lazy(() =>
  import("./History").then((m) => ({ default: m.History })),
);
const Channels = lazy(() =>
  import("./Channels").then((m) => ({ default: m.Channels })),
);
const PrivateValues = lazy(() =>
  import("./PrivateValues").then((m) => ({ default: m.PrivateValues })),
);
const Deliveries = lazy(() =>
  import("./Deliveries").then((m) => ({ default: m.Deliveries })),
);
const AccountSecurity = lazy(() =>
  import("./AccountSecurity").then((m) => ({ default: m.AccountSecurity })),
);
const Settings = lazy(() =>
  import("./Settings").then((m) => ({ default: m.Settings })),
);
import logo from "./assets/logo.svg";
const { Header, Sider, Content } = Layout;

function useCompactLayout() {
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

export default function FusionApp() {
  const themeAdapter = useThemeAdapter();
  const compactLayout = useCompactLayout();
  const [query, setQuery] = useState(""),
    [stateFilter, setStateFilter] = useState<string>();
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
    [collapsed, setCollapsed] = useState(false),
    [navigationOpen, setNavigationOpen] = useState(false);
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<any>(),
    [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  useEffect(() => {
    const expire = () => {
      setUser(null);
      setSelected(undefined);
      setMonitors([]);
      setChannels([]);
    };
    window.addEventListener("fusion-session-expired", expire);
    return () => window.removeEventListener("fusion-session-expired", expire);
  }, []);
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
    setNavigationOpen(false);
    history.replaceState(null, "", key === "jobs" ? "/jobs" : "/" + key);
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
    const userDefaults = m ? {} : await api("/preferences/monitoring").catch(() => ({}));
    form.setFieldsValue(
      m ? { ...defaults, ...(await api("/jobs/" + m.id)) } : { ...defaults, ...userDefaults },
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
  const remove = (m: any) =>
    Modal.confirm({
      title: "Delete monitor and history?",
      content: "This action cannot be undone.",
      okButtonProps: { danger: true },
      onOk: async () => {
        await api("/jobs/" + m.id, "DELETE");
        await reload();
      },
    });
  if (authLoading)
    return (
      <div className="center">
        <Spin />
      </div>
    );
  if (!user) return <Login onSuccess={() => void getUser()} />;
  const current = monitors.find((m) => m.id === selected?.id) ?? selected;
  const filteredMonitors = filterMonitors(monitors, query, stateFilter);
  const navigation = (
    <Menu
      selectedKeys={[page === "detail" ? "jobs" : page]}
      items={[
        { key: "jobs", icon: <EyeOutlined />, label: "Monitors" },
        { key: "notifications", icon: <BellOutlined />, label: "Notifications" },
        { key: "settings", icon: <SettingOutlined />, label: "Settings" },
      ]}
      onClick={({ key }) => navigate(key)}
    />
  );
  const signOut = async () => {
    try {
      await api("/logout", "POST", {});
      setUser(null);
    } catch (e) {
      void message.error((e as Error).message);
    }
  };
  return (
    <Layout className="shell">
      <Header className="header">
        {compactLayout && (
          <Button
            className="navigation-toggle"
            type="text"
            icon={<MenuOutlined />}
            aria-label="Open navigation"
            onClick={() => setNavigationOpen(true)}
          />
        )}
        <a
          href="/jobs"
          onClick={(e) => {
            e.preventDefault();
            navigate("jobs");
          }}
          className="brand"
        >
          <img src={logo} alt="Changd" />
          <span className="brand-name">Changd <span>Fusion</span></span>
        </a>
        <div className="theme-controls-slot">
          <AllMyThemeControls adapter={themeAdapter} />
        </div>
        <Space className="desktop-account-actions">
          <span className="user-name">{user.firstname || "Account"}</span>
          <Suspense>
            <AccountSecurity signedOut={() => setUser(null)} />
          </Suspense>
          <Button icon={<LogoutOutlined />} onClick={() => void signOut()}>
            Sign out
          </Button>
        </Space>
        {compactLayout && (
          <Dropdown
            trigger={["click"]}
            placement="bottomRight"
            dropdownRender={() => (
              <div className="account-menu">
                <div className="account-menu-name">{user.firstname || "Account"}</div>
                <Suspense>
                  <AccountSecurity signedOut={() => setUser(null)} />
                </Suspense>
                <Button icon={<LogoutOutlined />} danger block onClick={() => void signOut()}>
                  Sign out
                </Button>
              </div>
            )}
          >
            <Button type="text" aria-label="Open account menu" icon={<MoreOutlined />} />
          </Dropdown>
        )}
      </Header>
      <Layout>
        {compactLayout ? (
          <Drawer
            title="Changd Fusion"
            placement="left"
            open={navigationOpen}
            onClose={() => setNavigationOpen(false)}
            className="mobile-navigation"
          >
            {navigation}
          </Drawer>
        ) : (
          <Sider
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            collapsedWidth={64}
            theme={themeAdapter.resolved}
          >
            {navigation}
          </Sider>
        )}
        <Content className="content">
          {error && (
            <Alert
              title={error}
              type="error"
              showIcon
              action={<Button onClick={() => void reload()}>Retry</Button>}
            />
          )}
          <Suspense
            fallback={
              <div role="status" aria-label="Loading page">
                <Spin />
              </div>
            }
          >
            {page === "settings" ? (
              <Settings channels={channels} monitors={monitors} reload={() => void reload()} report={(s: string) => void message.info(s)} admin={user.user_type === 2} signedOut={() => setUser(null)} theme={themeAdapter} />
            ) : page === "notifications" ? (
              <>
                <Channels
                  channels={channels}
                  monitors={monitors}
                  reload={() => void reload()}
                  report={(s) => void message.info(s)}
                />
                <Deliveries admin={user.user_type === 2} />
              </>
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
                          : current.enabled && !current.paused
                            ? "green"
                            : "default"
                      }
                    >
                      {monitorState(current).replaceAll("_", " ")}
                    </Tag>
                    {current.text_enabled && <Tag>Text</Tag>}
                    {current.visual_enabled && (
                      <Tag>
                        {current.last_dimension_change
                          ? "Dimensions changed"
                          : "Visual: " + percent(current.last_percent)}
                      </Tag>
                    )}
                    {current.visual_enabled && (
                      <Tag>{current.capture_mode.replace("_", " ")}</Tag>
                    )}
                    <span>Every {current.interval_seconds}s</span>
                  </Space>
                  <Space wrap><Typography.Paragraph className="monitor-url">{current.url}</Typography.Paragraph><MonitorUrlActions url={current.url} message={message} /></Space>
                  {current.last_error && (
                    <Alert title={current.last_error} type="error" />
                  )}
                  <Typography.Text type="secondary">
                    Baseline advances only after a combined change event. Failed
                    captures preserve the baseline.
                  </Typography.Text>
                </Card>
                <Card size="small" className="event">
                  <Space wrap>
                    <span>
                      Last attempted:{" "}
                      {current.last_run
                        ? new Date(current.last_run).toLocaleString()
                        : "Never"}
                    </span>
                    <span>
                      Last successful:{" "}
                      {current.last_success_at
                        ? new Date(current.last_success_at).toLocaleString()
                        : "No baseline yet"}
                    </span>
                    <span>
                      Next:{" "}
                      {current.enabled && !current.paused
                        ? new Date(current.next_run).toLocaleString()
                        : "Not scheduled"}
                    </span>
                    <span>Failures: {current.failure_count}</span>
                    <span>Duration: {current.execution_ms ?? "—"} ms</span>
                  </Space>
                  {current.warning_code && (
                    <Alert
                      type="warning"
                      title={"Warning: " + current.warning_code}
                    />
                  )}
                </Card>
                {current.kind === "browser" && (
                  <details>
                    <summary>Private browser values</summary>
                    <PrivateValues monitor={current} />
                  </details>
                )}
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
                <div
                  className="dashboard-summary"
                  aria-label="Monitor overview"
                >
                  <Card size="small">
                    <strong>{monitors.length}</strong> monitors
                  </Card>
                  <Card size="small">
                    <strong>
                      {
                        monitors.filter(
                          (m) => m.enabled && !m.paused && !m.last_error,
                        ).length
                      }
                    </strong>{" "}
                    active
                  </Card>
                  <Card size="small">
                    <strong>
                      {monitors.filter((m) => m.last_error).length}
                    </strong>{" "}
                    retrying
                  </Card>
                </div>
                <Space wrap className="dashboard-tools">
                  <Input.Search
                    type="search"
                    aria-label="Search monitors"
                    placeholder="Search name or URL"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    allowClear
                  />
                  <Select
                    aria-label="Filter monitoring status"
                    placeholder="All statuses"
                    allowClear
                    value={stateFilter}
                    onChange={setStateFilter}
                    className="status-filter"
                    options={monitorStates.map((value) => ({
                      value,
                      label: value.replaceAll("_", " "),
                    }))}
                  />
                </Space>
                {compactLayout ? (
                  <section className="monitor-card-list" aria-label="Monitor list">
                    {loading ? (
                      <div className="mobile-loading" role="status" aria-label="Loading monitors"><Spin /></div>
                    ) : filteredMonitors.length === 0 ? (
                      <Card><Empty description="Create a monitor to track text and visual changes together." /></Card>
                    ) : (
                      filteredMonitors.map((m) => (
                        <Card key={m.id} className="monitor-card" size="small">
                          <div className="monitor-card-heading">
                            <Button type="link" className="monitor-card-name" onClick={() => void detail(m.id)}>
                              {m.name}
                            </Button>
                            <Dropdown
                              trigger={["click"]}
                              menu={{
                                items: [
                                  { key: "edit", label: "Edit" },
                                  { key: "delete", danger: true, label: "Delete" },
                                ],
                                onClick: ({ key }) => key === "edit" ? void edit(m) : remove(m),
                              }}
                            >
                              <Button aria-label={`More actions for ${m.name}`} type="text" icon={<MoreOutlined />} />
                            </Dropdown>
                          </div>
                          <Space className="monitor-url-line" wrap><Typography.Paragraph className="monitor-url" type="secondary" ellipsis={{ rows: 2, tooltip: m.url }}>
                            {m.url}
                          </Typography.Paragraph><MonitorUrlActions url={m.url} message={message} compact /></Space>
                          <Space className="monitor-tags" wrap>
                            {m.text_enabled && <Tag>Text</Tag>}
                            {m.visual_enabled && <Tag color="blue">Visual</Tag>}
                            {m.kind !== "browser" && <Tag>{m.kind}</Tag>}
                            <Tag color={m.last_error ? "red" : m.enabled && !m.paused ? "green" : "default"}>
                              {monitorState(m).replaceAll("_", " ")}
                            </Tag>
                            {m.warning_code && <Tag color="gold">Warning</Tag>}
                          </Space>
                          <dl className="monitor-card-meta">
                            <div><dt>Last checked</dt><dd>{m.last_run ? new Date(m.last_run).toLocaleString() : "Never"}</dd></div>
                            <div><dt>Last change</dt><dd>{m.last_change_at ? new Date(m.last_change_at).toLocaleString() : "—"}</dd></div>
                            {m.visual_enabled && <div><dt>Visual change</dt><dd>{m.last_dimension_change ? "Dimensions changed" : percent(m.last_percent)}</dd></div>}
                          </dl>
                          <Space className="monitor-card-actions" wrap>
                            <Button onClick={() => void detail(m.id)}>Details</Button>
                            <Button type="primary" onClick={() => void action(m.id, "run")}>Check now</Button>
                            <Button onClick={() => void edit(m)}>Edit</Button>
                          </Space>
                        </Card>
                      ))
                    )}
                  </section>
                ) : (
                <Card className="monitor-table-card">
                  <Table
                    rowKey="id"
                    loading={loading}
                    dataSource={filteredMonitors}
                    scroll={{ x: 960 }}
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    locale={{
                      emptyText: (
                        <Empty description="Create a monitor to track text and visual changes together." />
                      ),
                    }}
                    columns={[
                      {
                        title: "Monitor",
                        dataIndex: "name",
                        sorter: (a: any, b: any) =>
                          a.name.localeCompare(b.name),
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
                        title: "URL",
                        responsive: ["md"],
                        render: (_, m: any) => <Space><Typography.Text ellipsis={{ tooltip: m.url }} style={{ maxWidth: 180 }}>{m.url}</Typography.Text><MonitorUrlActions url={m.url} message={message} compact /></Space>,
                      },
                      {
                        title: "Visual change",
                        dataIndex: "last_percent",
                        render: (v: string, m: any) =>
                          m.last_dimension_change ? (
                            <Tag>Dimensions changed</Tag>
                          ) : (
                            percent(v)
                          ),
                      },
                      {
                        title: "Status",
                        sorter: (a: any, b: any) =>
                          monitorState(a).localeCompare(monitorState(b)),
                        render: (_, m: any) => (
                          <Space wrap>
                            <Tag
                              color={
                                m.last_error
                                  ? "red"
                                  : m.enabled && !m.paused
                                    ? "green"
                                    : "default"
                              }
                            >
                              {monitorState(m).replaceAll("_", " ")}
                            </Tag>
                            {m.warning_code && <Tag color="gold">Warning</Tag>}
                          </Space>
                        ),
                      },
                      {
                        title: "Last change",
                        dataIndex: "last_change_at",
                        responsive: ["lg"],
                        sorter: (a: any, b: any) =>
                          Date.parse(a.last_change_at ?? "1970-01-01") -
                          Date.parse(b.last_change_at ?? "1970-01-01"),
                        render: (s: string) =>
                          s ? new Date(s).toLocaleString() : "—",
                      },
                      {
                        title: "Last checked",
                        dataIndex: "last_run",
                        responsive: ["lg"],
                        render: (s: string) =>
                          s ? new Date(s).toLocaleString() : "Never",
                      },
                      {
                        responsive: ["lg"],
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
                                remove(m)
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
                )}
              </>
            )}
          </Suspense>
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
        <MonitorForm form={form} channels={channels} monitorId={editing?.id} />
      </Modal>
    </Layout>
  );
}
