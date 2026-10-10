import { Form, Input, Select, Switch, InputNumber, Alert } from "antd";
import { BrowserStepsEditor } from "./BrowserStepsEditor";
export const defaults = {
  kind: "browser",
  text_enabled: true,
  visual_enabled: false,
  selector_type: "css",
  visual_threshold: "0.35",
  capture_mode: "viewport",
  capture_selector: "",
  capture_selector_type: "css",
  browser_steps: [],
  step_budget_ms: 20000,
  paused: false,
  notify_failures: false,
  notify_attention: false,
  pixel_threshold: 0.1,
  interval_seconds: 300,
  normalize_whitespace: true,
  ignore_case: false,
  enabled: true,
  channel_ids: [],
  ignore_selectors: [],
  ignore_text: [],
  mask_selectors: [],
};
export function MonitorForm({
  form,
  channels,
}: {
  form: any;
  channels: any[];
}) {
  const kind = Form.useWatch("kind", form),
    text = Form.useWatch("text_enabled", form),
    visual = Form.useWatch("visual_enabled", form),
    captureMode = Form.useWatch("capture_mode", form);
  return (
    <Form form={form} layout="vertical" initialValues={defaults}>
      <Form.Item name="name" label="Monitor name" rules={[{ required: true }]}>
        <Input maxLength={120} />
      </Form.Item>
      <Form.Item
        name="url"
        label="URL"
        rules={[{ required: true, type: "url" }]}
      >
        <Input placeholder="https://example.com" />
      </Form.Item>
      <Form.Item name="kind" label="Source">
        <Select
          options={[
            { value: "browser", label: "Browser — Text and Visual" },
            { value: "api", label: "API / JSON" },
            { value: "html", label: "HTML source" },
          ]}
          onChange={(v) => {
            if (v !== "browser")
              form.setFieldsValue({
                text_enabled: true,
                visual_enabled: false,
                capture_mode: "viewport",
                capture_selector: "",
                browser_steps: [],
              });
          }}
        />
      </Form.Item>
      <div className="form-row">
        <Form.Item
          name="text_enabled"
          label="Text detection"
          valuePropName="checked"
        >
          <Switch aria-label="Text detection" disabled={kind !== "browser"} />
        </Form.Item>
        <Form.Item
          name="visual_enabled"
          label="Visual detection"
          valuePropName="checked"
        >
          <Switch aria-label="Visual detection" disabled={kind !== "browser"} />
        </Form.Item>
        <Form.Item name="enabled" label="Active" valuePropName="checked">
          <Switch />
        </Form.Item>
      </div>
      {!text && !visual && (
        <Alert title="Enable Text, Visual, or both." type="warning" />
      )}
      {kind === "browser" && <BrowserStepsEditor form={form} />}
      {kind === "browser" && text && (
        <>
          <Form.Item name="selector_type" label="Extraction method">
            <Select
              options={[
                { value: "css", label: "CSS selector" },
                { value: "xpath", label: "XPath" },
              ]}
            />
          </Form.Item>
          <Form.Item name="selector" label="Selector (empty = full page text)">
            <Input placeholder="#content or //main" />
          </Form.Item>
          <Form.Item name="ignore_selectors" label="Remove dynamic regions">
            <Select mode="tags" placeholder="CSS selectors" />
          </Form.Item>
        </>
      )}
      {text && (
        <>
          <Form.Item name="ignore_text" label="Ignore literal text">
            <Select mode="tags" />
          </Form.Item>
          <div className="form-row">
            <Form.Item
              name="normalize_whitespace"
              label="Normalize whitespace"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              name="ignore_case"
              label="Ignore case"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
          </div>
        </>
      )}
      {visual && (
        <>
          <Form.Item
            name="capture_mode"
            label="Screenshot capture mode"
            extra="Fixed 1280×900 viewport, scale 1. Full-page and region captures are subject to server image limits."
          >
            <Select
              options={[
                { value: "viewport", label: "Viewport (default)" },
                { value: "full_page", label: "Full page" },
                { value: "element", label: "Selected element / region" },
              ]}
            />
          </Form.Item>
          {captureMode === "element" && (
            <>
              <Form.Item
                name="capture_selector_type"
                label="Region selector type"
              >
                <Select
                  options={[
                    { value: "css", label: "CSS" },
                    { value: "xpath", label: "XPath" },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="capture_selector"
                label="Screenshot region selector"
                rules={[{ required: true, whitespace: true }]}
                extra="Must match exactly one visible element. Independent of the text extraction selector."
              >
                <Input placeholder="#content or //main" maxLength={1000} />
              </Form.Item>
            </>
          )}

          <Form.Item
            name="visual_threshold"
            label="Visual alert threshold (%)"
            extra="For equal image sizes, alerts only above the threshold; equality does not alert. Dimension changes alert once without a percentage and advance the baseline."
          >
            <InputNumber stringMode min="0" max="100" step="0.01" />
          </Form.Item>
          <Form.Item name="pixel_threshold" label="Pixel color tolerance">
            <InputNumber min={0} max={1} step={0.01} />
          </Form.Item>
          <Form.Item name="mask_selectors" label="Mask dynamic regions">
            <Select mode="tags" placeholder="CSS selectors" />
          </Form.Item>
        </>
      )}
      <Form.Item
        name="interval_seconds"
        label="Check interval (seconds)"
        rules={[{ required: true }]}
      >
        <InputNumber min={30} max={604800} />
      </Form.Item>
      <div className="form-row">
        <Form.Item name="paused" label="Pause schedule" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="notify_failures"
          label="Persistent failure alerts"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
        <Form.Item
          name="notify_attention"
          label="Authentication / challenge alerts"
          valuePropName="checked"
        >
          <Switch />
        </Form.Item>
      </div>
      <Form.Item name="channel_ids" label="Notification channels">
        <Select
          mode="multiple"
          options={channels.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Form.Item>
    </Form>
  );
}
