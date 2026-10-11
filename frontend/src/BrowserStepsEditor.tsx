import {
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Button,
  Card,
  Space,
  Typography,
  Alert,
} from "antd";
export const stepActions = [
  "wait_selector",
  "wait_visible",
  "click",
  "scroll_to",
  "scroll_by",
  "wait_navigation",
  "delay",
  "dismiss_cookie",
  "select_option",
  "fill_literal",
  "fill_private",
];
const targeted = new Set([
  "wait_selector",
  "wait_visible",
  "click",
  "scroll_to",
  "dismiss_cookie",
  "select_option",
  "fill_literal",
  "fill_private",
]);
const optional = new Set([
  "wait_selector",
  "wait_visible",
  "dismiss_cookie",
  "scroll_to",
]);
function StepFields({ name, form }: { name: number; form: any }) {
  const action = Form.useWatch(["browser_steps", name, "action"], form);
  return (
    <>
      <Form.Item
        name={[name, "action"]}
        label="Action"
        rules={[{ required: true }]}
      >
        <Select
          virtual={false}
          aria-label={`Step ${name + 1} action`}
          options={stepActions.map((value) => ({
            value,
            label: value.replaceAll("_", " "),
          }))}
          onChange={(value) => {
            const steps = [...(form.getFieldValue("browser_steps") ?? [])];
            steps[name] = {
              action: value,
              timeout_ms: 5000,
              continue_on_error: false,
              ...(targeted.has(value)
                ? { selector: "", selector_type: "css" }
                : {}),
              ...(value === "scroll_by" ? { x: 0, y: 500 } : {}),
              ...(value === "delay" ? { duration_ms: 500 } : {}),
              ...(value === "wait_navigation" ? { path: "/" } : {}),
              ...(["fill_literal", "select_option"].includes(value)
                ? { value: "" }
                : {}),
              ...(value === "fill_private" ? { credential: "" } : {}),
            };
            form.setFieldValue("browser_steps", steps);
          }}
        />
      </Form.Item>
      {targeted.has(action) && (
        <div className="step-target">
          <Form.Item name={[name, "selector_type"]} label="Selector type">
            <Select
              options={[
                { value: "css", label: "CSS" },
                { value: "xpath", label: "XPath" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name={[name, "selector"]}
            label="Selector"
            rules={[{ required: true, whitespace: true }]}
          >
            <Input maxLength={1000} placeholder="#content or //main" />
          </Form.Item>
        </div>
      )}
      {["fill_literal", "select_option"].includes(action) && (
        <Form.Item
          name={[name, "value"]}
          label={
            action === "fill_literal"
              ? "Non-sensitive literal value"
              : "Option value"
          }
          rules={[{ required: true }]}
          extra={
            action === "fill_literal"
              ? "Never put a password or token here. Use a private value reference instead."
              : undefined
          }
        >
          <Input maxLength={500} />
        </Form.Item>
      )}
      {action === "fill_private" && (
        <>
          <Alert
            type="info"
            title="Private values require HTTPS and text-only capture. Configure the write-only vault after saving this monitor."
          />
          <Form.Item
            name={[name, "credential"]}
            label="Private value reference"
            rules={[
              { required: true, pattern: /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/ },
            ]}
          >
            <Input maxLength={50} placeholder="account_password" />
          </Form.Item>
        </>
      )}
      {action === "scroll_by" && (
        <Space wrap>
          <Form.Item name={[name, "x"]} label="Horizontal pixels">
            <InputNumber min={-5000} max={5000} />
          </Form.Item>
          <Form.Item
            name={[name, "y"]}
            label="Vertical pixels"
            rules={[{ required: true }]}
          >
            <InputNumber min={-5000} max={5000} />
          </Form.Item>
        </Space>
      )}
      {action === "delay" && (
        <Form.Item
          name={[name, "duration_ms"]}
          label="Delay (ms)"
          rules={[{ required: true }]}
        >
          <InputNumber min={0} max={5000} />
        </Form.Item>
      )}
      {action === "wait_navigation" && (
        <Form.Item
          name={[name, "path"]}
          label="Expected path on current origin"
          rules={[{ required: true, pattern: /^\/(?!\/)[^#]*$/ }]}
          extra="Waits for this exact path after an earlier click. Does not navigate to another website."
        >
          <Input maxLength={1000} placeholder="/account" />
        </Form.Item>
      )}
      <Space wrap>
        <Form.Item
          name={[name, "timeout_ms"]}
          label="Step timeout (ms)"
          rules={[{ required: true }]}
        >
          <InputNumber min={100} max={10000} />
        </Form.Item>
        <Form.Item
          name={[name, "continue_on_error"]}
          label="Optional step"
          valuePropName="checked"
        >
          <Switch
            disabled={!optional.has(action)}
            aria-label={`Step ${name + 1} continue on error`}
          />
        </Form.Item>
      </Space>
    </>
  );
}
export function BrowserStepsEditor({ form }: { form: any }) {
  return (
    <section aria-label="Browser steps">
      <Typography.Title level={4}>Browser Steps</Typography.Title>
      <Typography.Paragraph type="secondary">
        Steps run in order before text and visual capture in the same secure
        browser session. Maximum 20 steps; the server capture deadline always
        applies.
      </Typography.Paragraph>
      <Form.Item name="step_budget_ms" label="Workflow budget (ms)">
        <InputNumber min={100} max={60000} />
      </Form.Item>
      <Form.List
        name="browser_steps"
        rules={[
          {
            validator: async (_, steps) => {
              if (steps?.length > 20) throw Error("Maximum 20 steps");
            },
          },
        ]}
      >
        {(fields, { add, remove, move }, { errors }) => (
          <>
            {fields.map(({ key, name }) => (
              <Card
                key={key}
                size="small"
                className="event"
                title={`Step ${name + 1}`}
                extra={
                  <Space>
                    <Button
                      aria-label={`Move step ${name + 1} up`}
                      disabled={name === 0}
                      onClick={() => move(name, name - 1)}
                    >
                      ↑
                    </Button>
                    <Button
                      aria-label={`Move step ${name + 1} down`}
                      disabled={name === fields.length - 1}
                      onClick={() => move(name, name + 1)}
                    >
                      ↓
                    </Button>
                    <Button
                      aria-label={`Remove step ${name + 1}`}
                      danger
                      onClick={() => remove(name)}
                    >
                      Remove
                    </Button>
                  </Space>
                }
              >
                <StepFields name={name} form={form} />
              </Card>
            ))}
            <Button
              disabled={fields.length >= 20}
              onClick={() =>
                add({
                  action: "wait_visible",
                  selector: "",
                  selector_type: "css",
                  timeout_ms: 5000,
                  continue_on_error: false,
                })
              }
            >
              Add browser step
            </Button>
            <Form.ErrorList errors={errors} />
          </>
        )}
      </Form.List>
    </section>
  );
}
