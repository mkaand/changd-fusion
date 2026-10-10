import { useEffect, useState } from "react";
import {
  Card,
  Form,
  Input,
  InputNumber,
  Button,
  Alert,
  Typography,
  Space,
} from "antd";
import { api } from "./api";
export function PrivateValues({ monitor }: { monitor: any }) {
  const [meta, setMeta] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const load = () =>
    api(`/jobs/${monitor.id}/private-values`)
      .then(setMeta)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    form.resetFields();
  }, [monitor.id]);
  const allowed =
    monitor.kind === "browser" &&
    !monitor.visual_enabled &&
    monitor.url.startsWith("https:");
  return (
    <Card className="event" title="Private browser values">
      <Typography.Paragraph>
        Write-only values encrypted for this monitor and account. HTTPS,
        text-only capture and same-origin browser traffic are required.
        Interactive login and cookie import are pending.
      </Typography.Paragraph>
      {meta?.value_names?.length > 0 && (
        <Typography.Paragraph>
          Stored references: {meta.value_names.join(", ")} · expires{" "}
          {new Date(meta.expires_at).toLocaleString()}
        </Typography.Paragraph>
      )}
      {error && <Alert type="error" title={error} />}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ days: 7 }}
        onFinish={async (b) => {
          setBusy(true);
          setError("");
          try {
            await api(`/jobs/${monitor.id}/private-values`, "PUT", {
              values: { [b.name]: b.value },
              expires_at: new Date(
                Date.now() + b.days * 86400000,
              ).toISOString(),
            });
            form.resetFields();
            await load();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form.Item
          name="name"
          label="Reference name"
          rules={[{ required: true, pattern: /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/ }]}
        >
          <Input disabled={!allowed} maxLength={50} />
        </Form.Item>
        <Form.Item
          name="value"
          label="Private value"
          rules={[{ required: true }]}
          extra="Saving replaces the vault. Values are never returned by the API. Use the API for multiple references."
        >
          <Input.Password
            autoComplete="new-password"
            disabled={!allowed}
            maxLength={512}
          />
        </Form.Item>
        <Form.Item name="days" label="Expires in days">
          <InputNumber min={1} max={30} />
        </Form.Item>
        <Space wrap>
          <Button htmlType="submit" disabled={!allowed} loading={busy}>
            Replace private values
          </Button>
          <Button
            danger
            disabled={!meta?.value_names?.length || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/jobs/${monitor.id}/private-values`, "DELETE");
                form.resetFields();
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Clear private values
          </Button>
        </Space>
      </Form>
    </Card>
  );
}
