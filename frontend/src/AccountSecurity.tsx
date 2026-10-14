import { useRef, useState } from "react";
import { Alert, Button, Form, Input, Modal, Space, Tag, Typography } from "antd";
import { api } from "./api";

export function AccountSecurity({ signedOut, sessionEstablished }: { signedOut: () => void; sessionEstablished?: () => void }) {
  const [open, setOpen] = useState(false);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [publicEnabled, setPublicEnabled] = useState(false);
  const [pendingPublicEnabled, setPendingPublicEnabled] = useState<boolean | null>(null);
  const publicMutation = useRef(false);
  const [verifyForm] = Form.useForm(), [passwordForm] = Form.useForm();

  const leave = async () => {
    try { await api("/security/leave", "POST", {}); } catch {}
    setVerified(false);
    verifyForm.resetFields();
    passwordForm.resetFields();
  };
  const close = async () => {
    await leave();
    setOpen(false);
    setError("");
    setPendingPublicEnabled(null);
  };
  const verify = async (values: unknown) => {
    setBusy(true); setError("");
    try {
      await api("/security/verify", "POST", values);
      const state = await api<{ public_enabled: boolean }>("/account/public-access");
      setPublicEnabled(state.public_enabled);
      setVerified(true);
      sessionEstablished?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const change = async (values: unknown) => {
    setBusy(true); setError("");
    try { await api("/users/changepassword", "POST", values); await close(); signedOut(); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const confirmPublicAccess = async () => {
    if (pendingPublicEnabled === null || publicMutation.current) return;
    const desired = pendingPublicEnabled;
    publicMutation.current = true;
    setBusy(true); setError("");
    try {
      const result = await api<{ enabled: boolean }>("/account/public-access", "PUT", { enabled: desired, confirm: true });
      if (result.enabled !== desired) throw new Error("The server did not confirm the requested Public Access state.");
      setPublicEnabled(result.enabled);
      setPendingPublicEnabled(null);
    } catch (cause) { setError((cause as Error).message); }
    finally { publicMutation.current = false; setBusy(false); }
  };
  const enabling = pendingPublicEnabled === true;

  return <>
    <Button onClick={() => { setError(""); setOpen(true); }}>Account security</Button>
    <Modal rootClassName="account-security-root" className="account-security-modal" title="Account security" open={open} onCancel={() => { if (!busy) void close(); }} footer={null} destroyOnHidden mask={{ closable: !busy }} keyboard={!busy}>
      {error && <Alert type="error" title={error} showIcon />}
      {!verified ? <Form form={verifyForm} layout="vertical" onFinish={verify}>
        <Typography.Paragraph>Verify your email and password to continue.</Typography.Paragraph>
        <Form.Item name="email" label="Email" rules={[{ required: true, type: "email" }]}><Input autoComplete="username" /></Form.Item>
        <Form.Item name="password" label="Password" rules={[{ required: true }]}><Input.Password autoComplete="current-password" maxLength={72} /></Form.Item>
        <Button htmlType="submit" type="primary" loading={busy}>Verify account</Button>
      </Form> : <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Paragraph>Changing your password or signing out all devices revokes active sessions.</Typography.Paragraph>
        <section className="public-access-control" aria-label="Public Access setting">
          <div><Typography.Text strong>Public Access</Typography.Text><Tag color={publicEnabled ? "green" : "default"}>{publicEnabled ? "Enabled" : "Disabled"}</Tag></div>
          <Button disabled={busy} onClick={() => { setError(""); setPendingPublicEnabled(!publicEnabled); }}>{publicEnabled ? "Disable public access" : "Enable public access"}</Button>
        </section>
        <Form form={passwordForm} layout="vertical" onFinish={change}>
          <Form.Item name="password" label="New password" rules={[{ required: true, min: 12, max: 72 }]}><Input.Password autoComplete="new-password" maxLength={72} /></Form.Item>
          <Button htmlType="submit" type="primary" loading={busy}>Change password</Button>
        </Form>
        <Button danger loading={busy} onClick={async () => { setBusy(true); try { await api("/logout-all", "POST", {}); await leave(); setOpen(false); signedOut(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }}>Sign out all devices</Button>
      </Space>}
    </Modal>
    <Modal rootClassName="public-access-confirmation" title={enabling ? "Enable public access?" : "Disable public access?"} open={pendingPublicEnabled !== null} onCancel={() => { if (!busy) setPendingPublicEnabled(null); }} onOk={() => void confirmPublicAccess()} okText={enabling ? "Enable public access" : "Disable public access"} cancelText="Cancel" confirmLoading={busy} okButtonProps={{ danger: !enabling, disabled: busy }} cancelButtonProps={{ disabled: busy }} width={480} mask={{ closable: !busy }} keyboard={!busy} destroyOnHidden>
      {error && <Alert type="error" title={error} showIcon />}
      <Typography.Paragraph>{enabling ? "Anonymous visitors will be able to use standard workspace features, including monitor and notification configuration. Account Security and protected secret values remain restricted." : "Anonymous workspace access will end immediately. Existing authenticated account sessions remain subject to normal session controls."}</Typography.Paragraph>
    </Modal>
  </>;
}
