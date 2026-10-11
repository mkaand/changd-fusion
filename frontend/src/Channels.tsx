import { useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Switch,
  Space,
  Tag,
  Empty,
  Typography,
} from "antd";
import { api } from "./api";
export function Channels({
  channels,
  monitors,
  reload,
  report,
}: {
  channels: any[];
  monitors: any[];
  reload: () => void;
  report: (s: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [editing, setEditing] = useState<any>(),
    [saving, setSaving] = useState(false),
    [validating, setValidating] = useState<string>(),
    [testMonitorId, setTestMonitorId] = useState<string>();
  const [preview, setPreview] = useState<{ kind: string; text: string }>();
  const [form] = Form.useForm();
  const provider = Form.useWatch("provider", form);
  const create = (channel?: any) => {
    setEditing(channel);
    form.resetFields();
    form.setFieldsValue(
      channel ?? {
        provider: "smtp",
        enabled: true,
        config: { port: 587, username: "", password: "" },
      },
    );
    setOpen(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      const b = await form.validateFields();
      await api(
        "/notifications" + (editing ? "/" + editing.id : ""),
        editing ? "PUT" : "POST",
        b,
      );
      setOpen(false);
      reload();
    } catch (e) {
      if (e instanceof Error) report(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Space className="page-header">
        <h2>Notification channels</h2>
        <Button type="primary" onClick={() => create()}>
          Add channel
        </Button>
        <Select aria-label="Telegram message preview" placeholder="Preview Telegram message" style={{ minWidth: 220 }} onChange={async (kind) => { try { setPreview({ kind, text: (await api(`/notifications/preview/${kind}`)).text }); } catch (e) { report((e as Error).message); } }} options={["text", "visual", "combined", "dimensions", "failure", "authentication", "challenge", "test", "digest"].map((value) => ({ value, label: value.replace(/^./, (c) => c.toUpperCase()) }))} />
      </Space>
      {preview && <Card className="telegram-preview" title={`Telegram preview: ${preview.kind}`} extra={<Button onClick={() => setPreview(undefined)}>Close</Button>}><Typography.Paragraph className="telegram-preview-text">{preview.text}</Typography.Paragraph><Typography.Text type="secondary">Preview only — no Telegram request is made.</Typography.Text></Card>}
      {!channels.length && (
        <Empty description="Add SMTP or Telegram to receive unified change alerts." />
      )}
      {channels.map((c) => (
        <Card key={c.id} className="event">
          <Space wrap>
            <strong>{c.name}</strong>
            <Tag>{c.provider}</Tag>
            <Tag>{c.enabled ? "Enabled" : "Disabled"}</Tag>
            {c.test_required && (
              <Tag color="warning">Send a test notification first</Tag>
            )}
            <Button onClick={() => create(c)}>Edit</Button>
            {c.provider === "telegram" && (
              <Button
                loading={validating === c.id}
                onClick={async () => {
                  setValidating(c.id);
                  try {
                    const result = await api(`/notifications/${c.id}/validate`, "POST", {});
                    report(`Bot validated: ${result.bot.first_name}${result.bot.username ? " (@" + result.bot.username + ")" : ""}`);
                  } catch (e) {
                    report((e as Error).message);
                  } finally { setValidating(undefined); }
                }}
              >Validate Bot</Button>
            )}
            <Button
              disabled={!testMonitorId}
              onClick={async () => {
                try {
                  await api("/notifications/" + c.id + "/test", "POST", {
                    monitor_id: testMonitorId,
                  });
                  report(
                    "Test notification queued. Delivery status appears in that monitor’s history.",
                  );
                } catch (e) {
                  report((e as Error).message);
                }
              }}
            >
              Test notification
            </Button>
            <Button
              danger
              onClick={() =>
                Modal.confirm({
                  title: "Delete this channel?",
                  onOk: async () => {
                    await api("/notifications/" + c.id, "DELETE");
                    reload();
                  },
                })
              }
            >
              Delete
            </Button>
          </Space>
        </Card>
      ))}
      {!!channels.length && <Select
        aria-label="Test notification monitor"
        placeholder="Select a monitor for test notifications"
        value={testMonitorId}
        onChange={setTestMonitorId}
        options={monitors.map((m) => ({ value: m.id, label: m.name || m.id }))}
        style={{ minWidth: 260, maxWidth: "100%" }}
      />}
      <Modal
        title={editing ? "Edit channel" : "Add channel"}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="Channel name"
            rules={[{ required: true }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="provider" label="Provider">
            <Select
              options={[
                { value: "smtp", label: "SMTP" },
                { value: "telegram", label: "Telegram" },
              ]}
              onChange={() => form.setFieldValue("config", {})}
            />
          </Form.Item>
          <Form.Item name="enabled" label="Enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          {provider === "telegram" ? (
            <>
              <Form.Item
                name={["config", "token"]}
                label="Bot token"
                rules={[{ required: !editing }]}
              >
                <Input.Password
                  placeholder={
                    editing
                      ? "Leave empty to retain credential"
                      : "Synthetic or securely supplied bot token"
                  }
                />
              </Form.Item>
              <Form.Item
                name={["config", "chat_id"]}
                label="Chat ID"
                rules={[{ required: true }]}
              >
                <Input />
              </Form.Item>
              <Form.Item
                name={["config", "timezone"]}
                label="Telegram timezone"
                initialValue="UTC"
              >
                <Select
                  options={[
                    { value: "UTC", label: "UTC" },
                    { value: "Europe/Istanbul", label: "Europe/Istanbul" },
                    { value: "Europe/Berlin", label: "Europe/Berlin" },
                    { value: "America/New_York", label: "America/New_York" },
                  ]}
                />
              </Form.Item>
              <p>
                Telegram messages are in English. Bot credentials are encrypted;
                the token is never returned. After saving, send a test
                notification yourself.
              </p>
              <ol className="telegram-help">
                <li>Create a bot with BotFather and copy its token.</li>
                <li>Start a chat with the bot, or add it to your group.</li>
                <li>Enter the chat ID, save, then validate and send a test.</li>
              </ol>
            </>
          ) : (
            <>
              <Form.Item
                name={["config", "host"]}
                label="SMTP hostname"
                rules={[{ required: true }]}
              >
                <Input placeholder="smtp.example.com" />
              </Form.Item>
              <Form.Item
                name={["config", "port"]}
                label="TLS port"
                rules={[{ required: true }]}
              >
                <Select
                  options={[
                    { value: 465, label: "465 — TLS" },
                    { value: 587, label: "587 — required STARTTLS" },
                  ]}
                />
              </Form.Item>
              <Form.Item name={["config", "username"]} label="Username">
                <Input />
              </Form.Item>
              <Form.Item name={["config", "password"]} label="Password">
                <Input.Password placeholder="Leave empty to retain credential" />
              </Form.Item>
              <Form.Item
                name={["config", "from"]}
                label="From address"
                rules={[{ required: true, type: "email" }]}
              >
                <Input placeholder="alerts@example.com" />
              </Form.Item>
              <Form.Item
                name={["config", "to"]}
                label="Recipient"
                rules={[{ required: true, type: "email" }]}
              >
                <Input placeholder="recipient@example.com" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
    </>
  );
}
