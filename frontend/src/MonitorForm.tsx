import { useRef, useState } from "react";
import { Collapse, DatePicker, Form, Input, InputNumber, Select, Switch, Alert } from "antd";
import { BrowserStepsEditor } from "./BrowserStepsEditor";
import { RegionPicker } from "./RegionPicker";
import { TextPicker } from "./TextPicker";
const HiddenObjectField = (_: { value?: unknown }) => null;

export const defaults = {
  kind: "browser", text_enabled: true, visual_enabled: false, selector_type: "css",
  visual_threshold: "0.35", capture_mode: "viewport", capture_selector: "", capture_selector_type: "css",
  browser_steps: [], step_budget_ms: 20000, paused: false, notify_failures: false, notify_attention: false,
  notification_enabled: true, notification_cooldown_seconds: 0, notification_mode: "immediate", digest_window_seconds: 3600,
  pixel_threshold: 0.1, interval_seconds: 300, normalize_whitespace: true, ignore_case: false, enabled: true,
  text_direction: "both", text_source: "direct", extraction_mode: "full_text", extraction_rule: null,
  channel_ids: [], ignore_selectors: [], ignore_text: [], mask_selectors: [],
};
export function isValidSelectedTextRule(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return Object.keys(rule).length === 5 && ["version", "kind", "before", "after", "max_length"].every((key) => key in rule) &&
    rule.version === 1 && rule.kind === "bounded_context" &&
    typeof rule.before === "string" && rule.before.length <= 160 &&
    typeof rule.after === "string" && rule.after.length <= 160 &&
    Number.isInteger(rule.max_length) && (rule.max_length as number) >= 1 &&
    (rule.max_length as number) <= 500 && !!(rule.before || rule.after);
}
export function MonitorForm({ form, channels, monitorId, onOpenMobileRegion, onOpenMobileText, advancedOpen, setAdvancedOpen }: { form: any; channels: any[]; monitorId?: string; onOpenMobileRegion?: () => void; onOpenMobileText?: () => void; advancedOpen?: boolean; setAdvancedOpen?: (open: boolean) => void }) {
  const [localAdvancedOpen, setLocalAdvancedOpen] = useState(false);
  const pendingJinaExtraction = useRef<{ extraction_mode: "full_text" | "product_price" | "selected_text"; extraction_rule: unknown } | undefined>(undefined);
  const isAdvancedOpen = advancedOpen ?? localAdvancedOpen;
  const updateAdvanced = (next: boolean) => setAdvancedOpen ? setAdvancedOpen(next) : setLocalAdvancedOpen(next);
  const kind = Form.useWatch("kind", form) ?? "browser", text = Form.useWatch("text_enabled", form) ?? true, visual = Form.useWatch("visual_enabled", form) ?? false, captureMode = Form.useWatch("capture_mode", form) ?? "viewport", textSource = Form.useWatch("text_source", form) ?? "direct", extractionMode = Form.useWatch("extraction_mode", form) ?? "full_text", extractionRule = Form.useWatch("extraction_rule", form);
  const detection = <div className="form-row monitor-detection-row">
    <Form.Item name="text_enabled" label="Text detection" valuePropName="checked"><Switch aria-label="Text detection" disabled={kind !== "browser"} /></Form.Item>
    <Form.Item name="visual_enabled" label="Visual detection" valuePropName="checked"><Switch aria-label="Visual detection" disabled={kind !== "browser"} /></Form.Item>
  </div>;
  return <Form form={form} layout="vertical" initialValues={defaults} className="monitor-editor-form">
    <Form.Item name="extraction_rule" hidden><HiddenObjectField /></Form.Item>
    <section className="monitor-editor-basics" aria-label="Monitor basics">
      <Form.Item name="name" label="Monitor name" rules={[{ required: true }]}><Input maxLength={120} /></Form.Item>
      <Form.Item name="url" label="URL" rules={[{ required: true, type: "url" }]}><Input placeholder="https://example.com" /></Form.Item>
      {detection}
      {!text && !visual && <Alert title="Enable Text, Visual, or both." type="warning" />}
      <Form.Item name="interval_seconds" label="Check interval (seconds)" rules={[{ required: true }]}><InputNumber min={30} max={604800} /></Form.Item>
      <Form.Item name="channel_ids" label="Notification channels"><Select mode="multiple" options={channels.map((c) => ({ value: c.id, label: c.name }))} /></Form.Item>
    </section>
    <Collapse className="monitor-editor-advanced" activeKey={isAdvancedOpen ? ["advanced"] : []} onChange={(keys) => updateAdvanced((keys as string[]).includes("advanced"))} items={[{ key: "advanced", label: "Advanced settings", children: <>
      <Form.Item name="kind" label="Source"><Select options={[{ value: "browser", label: "Browser — Text and Visual" }, { value: "api", label: "API / JSON" }, { value: "html", label: "HTML source" }]} onChange={(value) => { if (value !== "browser") form.setFieldsValue({ text_enabled: true, visual_enabled: false, capture_mode: "viewport", capture_selector: "", browser_steps: [] }); }} /></Form.Item>
      <div className="form-row"><Form.Item name="enabled" label="Active" valuePropName="checked"><Switch /></Form.Item><Form.Item name="paused" label="Pause schedule" valuePropName="checked"><Switch /></Form.Item></div>
      {kind === "browser" && textSource === "direct" && <BrowserStepsEditor form={form} />}
      {kind === "browser" && text && <>
        <Form.Item name="text_source" label="Text content source"><Select options={[{ value: "direct", label: "Direct browser content (default)" }, { value: "jina", label: "Jina Reader — sends the URL to a third party" }]} onChange={(value) => {
          if (value === "direct") {
            const extraction_mode = form.getFieldValue("extraction_mode") ?? "full_text";
            if (extraction_mode !== "full_text") pendingJinaExtraction.current = { extraction_mode, extraction_rule: form.getFieldValue("extraction_rule") };
            form.setFieldValue("extraction_mode", "full_text");
          } else if (pendingJinaExtraction.current) {
            form.setFieldsValue(pendingJinaExtraction.current);
          }
        }} /></Form.Item>
        {textSource === "jina" && <><Form.Item name="extraction_mode" label="Extraction mode"><Select options={[{ value: "full_text", label: "Full text (default)" }, { value: "product_price", label: "Product Price" }, { value: "selected_text", label: "Selected Text / Value" }]} /></Form.Item><Alert type="info" showIcon title="Jina Reader is optional" description="Only the monitor URL is sent to Jina Reader. Remote Markdown is treated as plain text; visual capture, private values, selectors, and Browser Steps are not used." />{extractionMode === "selected_text" && <><TextPicker monitorId={monitorId} onRequestMobile={onOpenMobileText} getDraft={() => form.getFieldsValue(true)} onApply={(rule) => form.setFieldsValue({ extraction_rule: rule, extraction_mode: "selected_text" })} />{!isValidSelectedTextRule(extractionRule) && <Alert type="warning" showIcon title="Select text and apply a valid extraction rule before saving." />}</> }</>}
        {textSource === "direct" && <><Form.Item name="selector_type" label="Text extraction method"><Select options={[{ value: "css", label: "CSS selector" }, { value: "xpath", label: "XPath" }]} /></Form.Item><Form.Item name="selector" label="Text selector (empty = visible page text)"><Input placeholder="#content or //main" /></Form.Item><Form.Item name="ignore_selectors" label="Remove dynamic regions"><Select mode="tags" placeholder="CSS selectors" /></Form.Item></>}
      </>}
      {text && (textSource === "direct" || extractionMode === "full_text") && <><Form.Item name="ignore_text" label="Ignore literal text"><Select mode="tags" /></Form.Item><div className="form-row"><Form.Item name="normalize_whitespace" label="Normalize whitespace" valuePropName="checked"><Switch /></Form.Item><Form.Item name="ignore_case" label="Ignore case" valuePropName="checked"><Switch /></Form.Item></div></>}
      {text && <Form.Item name="text_direction" label="Text notification direction" extra="Filters delivery only. History, Timeline, and the text baseline always retain both directions."><Select options={[{ value: "both", label: "Added & Removed (default)" }, { value: "added", label: "Added only" }, { value: "removed", label: "Removed only" }]} /></Form.Item>}
      {visual && <>
        <Form.Item name="capture_mode" label="Screenshot capture mode" extra="Fixed 1280×900 viewport, scale 1. Full-page and region captures are subject to server image limits."><Select options={[{ value: "viewport", label: "Viewport (default)" }, { value: "full_page", label: "Full page" }, { value: "element", label: "Selected element / region" }]} /></Form.Item>
        {captureMode === "element" && <>
          <Form.Item name="capture_selector_type" label="Region selector type"><Select options={[{ value: "css", label: "CSS" }, { value: "xpath", label: "XPath" }]} /></Form.Item>
          <Form.Item name="capture_selector" label="Screenshot region selector" rules={[{ required: true, whitespace: true }]} extra="Must match exactly one visible element. Independent of the text extraction selector."><Input placeholder="#content or //main" maxLength={1000} /></Form.Item>
          <RegionPicker monitorId={monitorId} onRequestMobile={onOpenMobileRegion} getDraft={() => form.getFieldsValue(true)} onSelect={(selector) => form.setFieldsValue({ capture_selector_type: "css", capture_selector: selector })} onUseViewport={() => form.setFieldsValue({ capture_mode: "viewport", capture_selector: "" })} />
        </>}
        <Form.Item name="visual_threshold" label="Visual alert threshold (%)" extra="For equal image sizes, alerts only above the threshold; equality does not alert. Dimension changes alert once without a percentage and advance the baseline."><InputNumber stringMode min="0" max="100" step="0.01" /></Form.Item>
        <Form.Item name="pixel_threshold" label="Pixel color tolerance"><InputNumber min={0} max={1} step={0.01} /></Form.Item>
        <Form.Item name="mask_selectors" label="Mask dynamic regions"><Select mode="tags" placeholder="CSS selectors" /></Form.Item>
      </>}
      <div className="form-row"><Form.Item name="notify_failures" label="Persistent failure alerts" valuePropName="checked"><Switch /></Form.Item><Form.Item name="notify_attention" label="Authentication / challenge alerts" valuePropName="checked"><Switch /></Form.Item><Form.Item name="notification_enabled" label="Send change notifications" valuePropName="checked"><Switch /></Form.Item></div>
      <div className="form-row"><Form.Item name="muted_until" label="Mute notifications until"><DatePicker showTime allowClear /></Form.Item><Form.Item name="notification_cooldown_seconds" label="Minimum notification interval"><Select options={[{value:0,label:"Off"},{value:300,label:"5 minutes"},{value:900,label:"15 minutes"},{value:1800,label:"30 minutes"},{value:3600,label:"1 hour"},{value:21600,label:"6 hours"},{value:86400,label:"24 hours"}]} /></Form.Item><Form.Item name="notification_mode" label="Notification mode"><Select options={[{value:"immediate",label:"Immediate"},{value:"digest",label:"Digest (hourly by default)"}]} /></Form.Item></div>
    </> }]} />
  </Form>;
}
