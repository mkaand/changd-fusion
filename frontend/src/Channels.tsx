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
    [saving, setSaving] = useState(false);
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
      </Space>
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
              <Tag color="warning">Önce test bildirimi gönderin</Tag>
            )}
            <Button onClick={() => create(c)}>Edit</Button>
            <Button
              disabled={!monitors.length}
              onClick={async () => {
                try {
                  await api("/notifications/" + c.id + "/test", "POST", {
                    monitor_id: monitors[0].id,
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
                label="Telegram saat dilimi"
                initialValue="Europe/Istanbul"
              >
                <Select
                  options={[
                    {
                      value: "Europe/Istanbul",
                      label: "Türkiye — Europe/Istanbul",
                    },
                    { value: "UTC", label: "UTC" },
                    { value: "Europe/Berlin", label: "Europe/Berlin" },
                    { value: "America/New_York", label: "America/New_York" },
                  ]}
                />
              </Form.Item>
              <p>
                Telegram mesajları Türkçedir. Bot bilgileri şifrelenir; token
                geri gönderilmez. Kaydettikten sonra Test notification düğmesini
                kendiniz kullanın.
              </p>
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
