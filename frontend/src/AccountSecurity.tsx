import { useState } from "react";
import { Button, Modal, Form, Input, Alert } from "antd";
import { api } from "./api";
export function AccountSecurity({ signedOut }: { signedOut: () => void }) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [form] = Form.useForm();
  const change = async (b: any) => {
    setBusy(true);
    setError("");
    try {
      await api("/users/changepassword", "POST", b);
      form.resetFields();
      signedOut();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>Account security</Button>
      <Modal
        title="Account security"
        open={open}
        onCancel={() => {
          setOpen(false);
          form.resetFields();
        }}
        footer={null}
        destroyOnHidden
      >
        {error && <Alert type="error" title={error} />}
        <p>
          Password changes revoke every account session. You will need to sign
          in again.
        </p>
        <Form form={form} layout="vertical" onFinish={change}>
          <Form.Item
            name="current_password"
            label="Current password"
            rules={[{ required: true }]}
          >
            <Input.Password autoComplete="current-password" maxLength={72} />
          </Form.Item>
          <Form.Item
            name="password"
            label="New password"
            rules={[{ required: true, min: 12, max: 72 }]}
          >
            <Input.Password autoComplete="new-password" maxLength={72} />
          </Form.Item>
          <Button htmlType="submit" type="primary" loading={busy}>
            Change password
          </Button>
        </Form>
        <Button
          className="event"
          danger
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/logout-all", "POST", {});
              signedOut();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Sign out all devices
        </Button>
      </Modal>
    </>
  );
}
