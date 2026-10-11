import { useState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { loginUser } from "./api";
import logo from "./assets/logo.svg";
export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  async function submit(values: { email: string; password: string }) {
    setLoading(true);
    setError("");
    try {
      await loginUser(values);
      onSuccess();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <main className="login">
      <Card>
        <img src={logo} width="42" alt="Changd" />
        <Typography.Title level={2}>Changd Fusion</Typography.Title>
        <Typography.Paragraph>Sign in to monitor changes.</Typography.Paragraph>
        {error && <Alert title={error} type="error" role="alert" />}
        <Form layout="vertical" onFinish={submit}>
          <Form.Item
            label="Email"
            name="email"
            rules={[{ required: true, type: "email" }]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            label="Password"
            name="password"
            rules={[{ required: true }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            Sign in
          </Button>
        </Form>
        <Typography.Paragraph type="secondary">
          Public registration is disabled by default. Ask your administrator for
          an account.
        </Typography.Paragraph>
      </Card>
    </main>
  );
}
