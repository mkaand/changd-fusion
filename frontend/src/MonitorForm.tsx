import { useRef, useState } from "react";
import { Collapse, DatePicker, Form, Input, InputNumber, Select, Switch, Alert, Radio, Typography } from "antd";
import { BrowserStepsEditor } from "./BrowserStepsEditor";
import { RegionPicker } from "./RegionPicker";
import { TextPicker } from "./TextPicker";
import { SelectedAreaPicker } from "./SelectedAreaPicker";
import { isValidSelectedTextRule } from "./selected-text-rule";
const HiddenObjectField = (_: { value?: unknown }) => null;

export const defaults = {
  kind: "browser", text_enabled: true, visual_enabled: false, selector_type: "css",
  visual_threshold: "0.35", capture_mode: "viewport", capture_selector: "", capture_selector_type: "css", capture_area: null,
  browser_steps: [], step_budget_ms: 20000, capture_timeout_ms: 60000, monitor_http_error_pages: false, disable_javascript: false, block_ads_trackers: false, cookie_banner_handling: false, wait_before_capture_ms: 0, mobile_view: false, paused: false, notify_failures: false, failure_alert_mode: "off", notify_attention: false,
  notification_enabled: true, notification_cooldown_seconds: 0, notification_mode: "immediate", digest_window_seconds: 3600,
  pixel_threshold: 0.1, interval_seconds: 300, normalize_whitespace: true, ignore_case: false, enabled: true,
  text_direction: "both", text_source: "direct", extraction_mode: "full_text", keyword: null, extraction_rule: null,
  channel_ids: [], ignore_selectors: [], ignore_text: [], mask_selectors: [],
};
export { isValidSelectedTextRule } from "./selected-text-rule";
export function MonitorForm({ form, channels, monitorId, onOpenMobileRegion, onOpenMobileArea, onOpenMobileText, onOpenMobileStep, advancedOpen, setAdvancedOpen, useDefaults = true }: { form: any; channels: any[]; monitorId?: string; onOpenMobileRegion?: () => void; onOpenMobileArea?: () => void; onOpenMobileText?: () => void; onOpenMobileStep?: () => void; advancedOpen?: boolean; setAdvancedOpen?: (open: boolean) => void; useDefaults?: boolean }) {
  const [localAdvancedOpen, setLocalAdvancedOpen] = useState(false);
  const pendingJinaExtraction = useRef<{ extraction_mode: "full_text" | "selected_text"; extraction_rule: unknown } | undefined>(undefined);
  const isAdvancedOpen = advancedOpen ?? localAdvancedOpen;
  const updateAdvanced = (next: boolean) => setAdvancedOpen ? setAdvancedOpen(next) : setLocalAdvancedOpen(next);
  const kind = Form.useWatch("kind", form) ?? "browser", text = Form.useWatch("text_enabled", form) ?? true, visual = Form.useWatch("visual_enabled", form) ?? false, captureMode = Form.useWatch("capture_mode", form) ?? "viewport", mobileView = Form.useWatch("mobile_view", form) ?? false, textSource = Form.useWatch("text_source", form) ?? "direct", extractionMode = Form.useWatch("extraction_mode", form) ?? "full_text", extractionRule = Form.useWatch("extraction_rule", form);
  const detection = <div className="form-row monitor-detection-row">
    <Form.Item name="text_enabled" label="Text detection" valuePropName="checked"><Switch aria-label="Text detection" disabled={kind !== "browser"} /></Form.Item>
    <Form.Item name="visual_enabled" label="Visual detection" valuePropName="checked"><Switch aria-label="Visual detection" disabled={kind !== "browser"} onChange={(enabled) => { if (!enabled && form.getFieldValue("capture_mode") === "selected_area") form.setFieldsValue({ capture_mode: "viewport", capture_area: null }); }} /></Form.Item>
  </div>;
  return <Form form={form} layout="vertical" initialValues={useDefaults ? defaults : undefined} className="monitor-editor-form">
    <Form.Item name="extraction_rule" hidden><HiddenObjectField /></Form.Item>
    <Form.Item name="capture_area" hidden><HiddenObjectField /></Form.Item>
    <section className="monitor-editor-basics" aria-label="Monitor basics">
      <Form.Item name="name" label="Monitor name" rules={[{ required: true }]}><Input maxLength={120} /></Form.Item>
      <Form.Item name="url" label="URL" rules={[{ required: true, type: "url" }]}><Input placeholder="https://example.com" /></Form.Item>
      {detection}
      {!text && !visual && <Alert title="Enable Text, Visual, or both." type="warning" />}
      <Form.Item name="interval_seconds" label="Check interval (seconds)" rules={[{ required: true }]}><InputNumber min={30} max={604800} /></Form.Item>
      <Form.Item name="channel_ids" label="Notification channels"><Select mode="multiple" options={channels.map((c) => ({ value: c.id, label: c.name }))} /></Form.Item>
    </section>
    <Collapse className="monitor-editor-advanced" activeKey={isAdvancedOpen ? ["advanced"] : []} onChange={(keys) => updateAdvanced((keys as string[]).includes("advanced"))} items={[{ key: "advanced", label: "Advanced settings", children: <>
      <Form.Item name="kind" label="Source"><Select options={[{ value: "browser", label: "Browser — Text and Visual" }, { value: "api", label: "API / JSON" }, { value: "html", label: "HTML source" }]} onChange={(value) => { if (value !== "browser") form.setFieldsValue({ text_enabled: true, visual_enabled: false, capture_mode: "viewport", capture_selector: "", capture_area: null, browser_steps: [], capture_timeout_ms: null }); }} /></Form.Item>
      <div className="form-row"><Form.Item name="enabled" label="Active" valuePropName="checked"><Switch /></Form.Item><Form.Item name="paused" label="Pause schedule" valuePropName="checked"><Switch /></Form.Item></div>
      {kind === "browser" && <Form.Item name="capture_timeout_ms" label="Capture timeout" extra="Applies to scheduled capture and draft visual previews. Existing legacy monitors can retain the server fallback."><Select aria-label="Capture timeout" options={[{ value: null, label: "Use legacy server fallback" }, { value: 30000, label: "30 seconds" }, { value: 45000, label: "45 seconds" }, { value: 60000, label: "60 seconds (default)" }, { value: 75000, label: "75 seconds" }, { value: 90000, label: "90 seconds" }]} /></Form.Item>}
      {kind === "browser" && <section className="browser-rendering-controls" aria-label="Browser rendering controls"><Typography.Title level={5}>Browser rendering</Typography.Title><Form.Item name="monitor_http_error_pages" label="Monitor HTTP error pages" valuePropName="checked" extra="Stores observed HTTP status and can capture error-page content without treating it as a transport failure."><Switch /></Form.Item><Form.Item name="disable_javascript" label="Disable JavaScript" valuePropName="checked" extra="Browser steps that depend on page JavaScript may fail."><Switch /></Form.Item><Form.Item name="block_ads_trackers" label="Block ads & trackers" valuePropName="checked"><Switch /></Form.Item><Form.Item name="cookie_banner_handling" label="Dismiss cookie banners" valuePropName="checked" extra="Only explicit Reject/Decline controls inside a cookie consent dialog are attempted. Consent is never accepted automatically, and a manual dismiss_cookie step takes precedence."><Switch /></Form.Item><Form.Item name="wait_before_capture_ms" label="Wait before capture"><Select options={[{value:0,label:"No extra wait"},{value:2000,label:"2 seconds"},{value:5000,label:"5 seconds"},{value:10000,label:"10 seconds"}]} /></Form.Item><Form.Item name="mobile_view" label="Mobile view" valuePropName="checked" extra={captureMode === "selected_area" ? "Selected Area uses fixed desktop coordinates. Choose another capture mode before enabling Mobile view." : "Uses an isolated 390×844 mobile viewport in Preview and scheduled capture."}><Switch disabled={captureMode === "selected_area"} /></Form.Item></section>}
      {kind === "browser" && textSource === "direct" && <BrowserStepsEditor form={form} monitorId={monitorId} onOpenMobileStep={onOpenMobileStep} />}
      {kind === "browser" && text && <section className="text-monitoring-controls" aria-label="Text monitoring settings">
        <Form.Item name="text_source" label="Text content source"><Select options={[{ value: "direct", label: "Direct browser content (default)" }, { value: "jina", label: "Jina Reader — sends the URL to a third party" }]} onChange={(value) => {
          if (value === "direct") {
            const extraction_mode = form.getFieldValue("extraction_mode") ?? "full_text";
            if (extraction_mode === "selected_text") pendingJinaExtraction.current = { extraction_mode, extraction_rule: form.getFieldValue("extraction_rule") };
            form.setFieldValue("extraction_mode", "full_text");
          } else if (pendingJinaExtraction.current) {
            form.setFieldsValue(pendingJinaExtraction.current);
          }
        }} /></Form.Item>
        <div className="text-monitoring-mode ant-form-item"><span id="text-monitoring-mode-label">Text monitoring mode</span><Form.Item name="extraction_mode" noStyle><Radio.Group aria-labelledby="text-monitoring-mode-label" optionType="button" buttonStyle="solid" onChange={() => { pendingJinaExtraction.current = undefined; }} options={textSource === "jina" ? [{ value: "full_text", label: "Full Text Changes" }, { value: "selected_text", label: "Selected Text / Value" }, { value: "keyword_presence", label: "Keyword Presence" }] : [{ value: "full_text", label: "Full Text Changes" }, { value: "keyword_presence", label: "Keyword Presence" }]} /></Form.Item></div>
        <Typography.Text type="secondary" className="text-monitoring-mode-help">{extractionMode === "keyword_presence" ? "Watches whether a literal word or phrase exists in the extracted text." : extractionMode === "selected_text" ? "Uses Text Picker context to follow one selected value." : "Compares the complete extracted text for content differences."}</Typography.Text>
        {textSource === "jina" && <Typography.Text type="secondary" className="jina-reader-notice">Jina Reader sends the monitored URL to a third-party service.</Typography.Text>}
        {extractionMode === "keyword_presence" && <Form.Item name="keyword" label="Keyword" rules={[{ required: true, whitespace: true, message: "Enter a keyword or phrase to monitor." }]} extra="Matching is literal, case-insensitive, and limited to complete words or phrases."><Input maxLength={200} /></Form.Item>}
        {textSource === "jina" && extractionMode === "selected_text" && <div className="jina-selected-text-controls"><TextPicker monitorId={monitorId} onRequestMobile={onOpenMobileText} getDraft={() => form.getFieldsValue(true)} onApply={(rule) => { form.setFieldValue("extraction_rule", rule); form.setFieldValue("extraction_mode", "selected_text"); }} />{!isValidSelectedTextRule(extractionRule) && <Alert type="warning" showIcon title="Select text and apply a valid extraction rule before saving." />}</div>}
        {textSource === "direct" && <><Form.Item name="selector_type" label="Text extraction method"><Select options={[{ value: "css", label: "CSS selector" }, { value: "xpath", label: "XPath" }]} /></Form.Item><Form.Item name="selector" label="Text selector (empty = visible page text)"><Input placeholder="#content or //main" /></Form.Item><Form.Item name="ignore_selectors" label="Remove dynamic regions"><Select mode="tags" placeholder="CSS selectors" /></Form.Item></>}
      </section>}
      {text && (textSource === "direct" || extractionMode !== "selected_text") && <><Form.Item name="ignore_text" label="Ignore literal text"><Select mode="tags" /></Form.Item><div className="form-row"><Form.Item name="normalize_whitespace" label="Normalize whitespace" valuePropName="checked"><Switch /></Form.Item><Form.Item name="ignore_case" label="Ignore case" valuePropName="checked"><Switch /></Form.Item></div></>}
      {text && <Form.Item className="notification-direction-control" name="text_direction" label="Notification direction" extra={extractionMode === "keyword_presence" ? "Added means absent → present; Removed means present → absent." : "Filters delivery only. History, Timeline, and the text baseline always retain both directions."}><Radio.Group aria-label="Notification direction" options={[{ value: "added", label: "Added only" }, { value: "removed", label: "Removed only" }, { value: "both", label: "Added & Removed" }]} /></Form.Item>}
      {visual && <>
        <Form.Item className="screenshot-capture-mode" name="capture_mode" label="Screenshot capture mode" extra="Desktop uses 1280×900 and Mobile view uses 390×844, both at scale 1. Full-page and region captures are subject to server image limits."><Select onChange={(value) => { if (value !== "selected_area") form.setFieldValue("capture_area", null); }} options={[{ value: "viewport", label: "Viewport (default)" }, { value: "full_page", label: "Full page" }, { value: "element", label: "Selected element / region" }, { value: "selected_area", label: "Selected area", disabled: mobileView }]} /></Form.Item>
        {captureMode === "element" && <>
          <Form.Item name="capture_selector_type" label="Region selector type"><Select options={[{ value: "css", label: "CSS" }, { value: "xpath", label: "XPath" }]} /></Form.Item>
          <Form.Item name="capture_selector" label="Screenshot region selector" rules={[{ required: true, whitespace: true }]} extra="Must match exactly one visible element. Independent of the text extraction selector."><Input placeholder="#content or //main" maxLength={1000} /></Form.Item>
          <RegionPicker monitorId={monitorId} onRequestMobile={onOpenMobileRegion} getDraft={() => form.getFieldsValue(true)} onSelect={(selector) => form.setFieldsValue({ capture_selector_type: "css", capture_selector: selector })} onUseViewport={() => form.setFieldsValue({ capture_mode: "viewport", capture_selector: "" })} />
        </>}
        {captureMode === "selected_area" && <div className="selected-area-form-control">
          <Typography.Paragraph type="secondary">Tracks fixed viewport coordinates. Use Selected element when the target should follow a moving DOM element.</Typography.Paragraph>
          <SelectedAreaPicker monitorId={monitorId} onRequestMobile={onOpenMobileArea} getDraft={() => form.getFieldsValue(true)} onApply={(capture_area) => form.setFieldsValue({ capture_mode: "selected_area", capture_area })} />
        </div>}
        <Form.Item name="visual_threshold" label="Visual alert threshold (%)" extra="For equal image sizes, alerts only above the threshold; equality does not alert. Dimension changes alert once without a percentage and advance the baseline."><InputNumber stringMode min="0" max="100" step="0.01" /></Form.Item>
        <Form.Item name="pixel_threshold" label="Pixel color tolerance"><InputNumber min={0} max={1} step={0.01} /></Form.Item>
        <Form.Item name="mask_selectors" label="Mask dynamic regions"><Select mode="tags" placeholder="CSS selectors" /></Form.Item>
      </>}
      <div className="form-row"><Form.Item name="failure_alert_mode" label="Error alerts" extra="HTTP error-page observations are change events, not capture failures."><Select options={[{ value: "off", label: "Off" }, { value: "first_or_persistent", label: "First or persistent failure" }, { value: "every", label: "Every failure" }]} /></Form.Item><Form.Item name="notify_attention" label="Authentication / challenge alerts" valuePropName="checked"><Switch /></Form.Item><Form.Item name="notification_enabled" label="Send change notifications" valuePropName="checked"><Switch /></Form.Item></div>
      <div className="form-row"><Form.Item name="muted_until" label="Mute notifications until"><DatePicker showTime allowClear /></Form.Item><Form.Item name="notification_cooldown_seconds" label="Minimum notification interval"><Select options={[{value:0,label:"Off"},{value:300,label:"5 minutes"},{value:900,label:"15 minutes"},{value:1800,label:"30 minutes"},{value:3600,label:"1 hour"},{value:21600,label:"6 hours"},{value:86400,label:"24 hours"}]} /></Form.Item><Form.Item name="notification_mode" label="Notification mode"><Select options={[{value:"immediate",label:"Immediate"},{value:"digest",label:"Digest (hourly by default)"}]} /></Form.Item></div>
    </> }]} />
  </Form>;
}
