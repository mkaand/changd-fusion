import { z } from "zod";
import { Decimal } from "decimal.js";
import { captureAreaSchema } from "./capture-area.js";
import { stepsSchema } from "./browser-steps.js";
import { captureTimeoutSchema } from "./capture-timeout.js";
// Shared, strict monitor validation used by the single-container SQLite API.
const uuid = z.string().uuid();
const threshold = z
  .union([
    z.string().regex(/^(?:\d{1,3})(?:\.\d{1,10})?$/),
    z.number().finite(),
  ])
  .transform(String)
  .refine(
    (n) =>
      Number(n) >= 0 &&
      Number(n) <= 100 &&
      new Decimal(n).decimalPlaces() <= 10,
  );
export const monitorInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    url: z.string().url().max(2048),
    kind: z.enum(["browser", "html", "api", "file"]).default("browser"),
    text_enabled: z.boolean().default(true),
    text_direction: z.enum(["added", "removed", "both"]).default("both"),
    text_source: z.enum(["direct", "jina", "markdown_new"]).default("direct"),
    markdown_render: z.enum(["auto", "browser"]).default("auto"),
    extraction_mode: z.enum(["full_text", "selected_text", "keyword_presence"]).default("full_text"),
    keyword: z.string().trim().min(1).max(200).nullable().default(null),
    extraction_rule: z.union([
      z.object({
        version: z.literal(1), kind: z.literal("bounded_context"),
        before: z.string().max(160), after: z.string().max(160),
        max_length: z.number().int().min(1).max(500),
      }).strict().refine((rule) => !!(rule.before || rule.after), { message: "Selected text rule requires stable context" }),
      z.object({
        version: z.literal(2), kind: z.literal("anchored_lines"),
        anchors: z.array(z.object({ text: z.string().min(1).max(160), offset: z.union([z.literal(-2), z.literal(-1), z.literal(1), z.literal(2)]) }).strict()).min(2).max(4),
        prefix: z.string().max(160), suffix: z.string().max(160),
        max_length: z.number().int().min(1).max(500),
      }).strict(),
    ]).nullable().default(null),
    visual_enabled: z.boolean().default(false),
    selector: z.string().max(1000).default(""),
    selector_type: z.enum(["css", "xpath"]).default("css"),
    ignore_selectors: z.array(z.string().min(1).max(500)).max(20).default([]),
    mask_selectors: z.array(z.string().min(1).max(500)).max(20).default([]),
    ignore_text: z.array(z.string().max(500)).max(30).default([]),
    normalize_whitespace: z.boolean().default(true),
    ignore_case: z.boolean().default(false),
    capture_mode: z
      .enum(["viewport", "full_page", "element", "selected_area"])
      .default("viewport"),
    capture_area: captureAreaSchema.nullable().default(null),
    capture_selector: z.string().max(1000).default(""),
    capture_selector_type: z.enum(["css", "xpath"]).default("css"),
    browser_steps: stepsSchema,
    step_budget_ms: z.number().int().min(100).max(60000).default(20000),
    capture_timeout_ms: captureTimeoutSchema.nullable().optional(),
    monitor_http_error_pages: z.boolean().default(false),
    disable_javascript: z.boolean().default(false),
    block_ads_trackers: z.boolean().default(false),
    cookie_banner_handling: z.boolean().default(false),
    wait_before_capture_ms: z.union([z.literal(0), z.literal(2000), z.literal(5000), z.literal(10000)]).default(0),
    mobile_view: z.boolean().default(false),
    paused: z.boolean().default(false),
    notify_failures: z.boolean().default(false),
    failure_alert_mode: z.enum(["off", "first_or_persistent", "every"]).optional(),
    notify_attention: z.boolean().default(false),
    notification_enabled: z.boolean().default(true),
    muted_until: z.string().datetime().nullable().optional(),
    notification_cooldown_seconds: z
      .union([z.literal(0), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600), z.literal(21600), z.literal(86400)])
      .default(0),
    notification_mode: z.enum(["immediate", "digest"]).default("immediate"),
    digest_window_seconds: z.number().int().min(300).max(86400).default(3600),
    visual_threshold: threshold.default("0.35"),
    pixel_threshold: z.coerce.number().min(0).max(1).default(0.1),
    interval_seconds: z.number().int().min(30).max(604800).default(300),
    enabled: z.boolean().default(true),
    channel_ids: z.array(uuid).max(20).default([]),
  })
  .strict()
  .refine((m) => m.capture_mode !== "element" || !!m.capture_selector.trim(), {
    message: "Element capture requires a selector",
  })
  .refine((m) => !m.mobile_view || m.capture_mode !== "selected_area", {
    message: "Selected area is not available in mobile view",
  })
  .refine((m) => m.capture_mode !== "selected_area" || !!m.capture_area, {
    message: "Selected area capture requires valid coordinates",
  })
  .refine((m) => m.capture_mode === "selected_area" || m.capture_area === null, {
    message: "Selected area coordinates require selected area capture mode",
  })
  .refine((m) => m.capture_mode !== "selected_area" || (m.kind === "browser" && m.visual_enabled), {
    message: "Selected area capture requires Browser visual detection",
  })
  .refine((m) => m.kind === "browser" || m.browser_steps.length === 0, {
    message: "Browser steps require a browser monitor",
  })
  .refine(
    (m) =>
      m.text_source !== "direct" || !m.browser_steps.some((s) => s.action === "fill_private") ||
      (!m.visual_enabled && new URL(m.url).protocol === "https:"),
    { message: "Private steps require HTTPS text-only capture" },
  )
  .refine((m) => m.text_enabled || m.visual_enabled, {
    message: "Enable at least one detection method",
  })
  .refine((m) => m.text_source === "direct" || (m.kind === "browser" && m.text_enabled && !m.visual_enabled), {
    message: "Third-party readers are available only for text-only Browser monitors",
  })
  .refine((m) => m.extraction_mode !== "selected_text" || (m.kind === "browser" && m.text_enabled), {
    message: "Selected Text extraction requires Browser text detection",
  })
  .refine((m) => m.extraction_mode !== "selected_text" || !!m.extraction_rule, {
    message: "Selected Text extraction requires a validated rule",
  })
  .refine((m) => m.extraction_mode !== "keyword_presence" || !!m.keyword, {
    message: "Keyword Presence extraction requires a keyword",
  })
  .refine((m) => m.extraction_mode !== "keyword_presence" || m.kind === "browser", {
    message: "Keyword Presence extraction requires a Browser monitor",
  })
  .refine(
    (m) => m.kind === "browser" || (m.text_enabled && !m.visual_enabled),
    { message: "HTML/API/File monitors require text-only detection" },
  )
  .transform((m) => ({
    ...m,
    failure_alert_mode: m.failure_alert_mode ?? (m.notify_failures ? "first_or_persistent" as const : "off" as const),
  }));
