import { chromium, type Browser } from "playwright";
import { EgressPolicy, browserProxy } from "./egress.js";
import type { Config } from "./config.js";
import { HttpError, captureFailure, type CaptureFailureCode, type CaptureStage } from "./errors.js";
import { checkDimensions, pngDimensions } from "./image.js";
import type { Monitor } from "./capture.js";

export type RegionPreviewFailure = {
  stage: CaptureStage;
  failure_code: CaptureFailureCode;
  status: number;
  message: string;
};

function previewMessage(stage: CaptureStage, code: CaptureFailureCode) {
  if (code === "timeout") return "Preview timed out. Retry, or use viewport capture instead.";
  if (code === "egress_denied") return "Preview destination is not permitted.";
  if (code === "selector_failed") return "The selected region is not a unique visible element.";
  if (stage === "navigation") return "Website preview could not be loaded. Check the URL and try again.";
  if (stage === "screenshot") return "Screenshot preview could not be created. Retry, or use viewport capture instead.";
  return "Website preview failed. Retry, or use viewport capture instead.";
}

export function regionPreviewFailure(error: unknown, stage: CaptureStage): RegionPreviewFailure {
  const safe = captureFailure(error, stage);
  const validation = error instanceof HttpError && error.status >= 400 && error.status < 500;
  return {
    stage: safe.stage,
    failure_code: safe.code,
    status: safe.code === "timeout" ? 504 : validation ? error.status : 422,
    message: previewMessage(safe.stage, safe.code),
  };
}

export async function previewRegion(m: Monitor, cfg: Config, point?: { x: number; y: number }, policy = new EgressPolicy()) {
  if (m.kind !== "browser" || !m.visual_enabled) throw new HttpError(422, "Visual browser capture is required");
  if ((m.browser_steps ?? []).some((step) => step.action === "fill_private")) throw new HttpError(422, "Region preview does not use private values");
  let stage: CaptureStage = "target_validation";
  const deadline = Date.now() + cfg.CAPTURE_TIMEOUT_MS;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new HttpError(504, "Preview timed out");
    return value;
  };
  let proxy: Awaited<ReturnType<typeof browserProxy>> | undefined;
  let browser: Browser | undefined;
  try {
    await policy.target(m.url);
    proxy = await browserProxy(policy);
    stage = "browser_launch";
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      timeout: remaining(),
    });
    stage = "browser_context";
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", serviceWorkers: "block", ignoreHTTPSErrors: false });
    await context.route("**/*", async (route) => {
      try { await policy.target(route.request().url()); await route.continue(); }
      catch { await route.abort("blockedbyclient"); }
    });
    const page = await context.newPage();
    stage = "navigation";
    const response = await page.goto(m.url, { waitUntil: "domcontentloaded", timeout: remaining() });
    if (!response?.ok()) throw new HttpError(422, `HTTP ${response?.status() ?? 0}`);
    await page.addStyleTag({ content: "* { animation:none !important; transition:none !important; caret-color:transparent !important; }" });
    stage = "screenshot";
    const image = await page.screenshot({ type: "png", animations: "disabled", timeout: remaining() });
    pngDimensions(image, { width: cfg.MAX_CAPTURE_WIDTH, height: cfg.MAX_CAPTURE_HEIGHT, pixels: cfg.MAX_CAPTURE_PIXELS });
    let selection: { selector: string; visible: boolean; x: number; y: number; width: number; height: number } | null = null;
    if (point) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > 1280 || point.y > 900) throw new HttpError(422, "Invalid preview point");
      stage = "text_extraction";
      selection = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        if (!element) return null;
        const parts: string[] = [];
        let node: Element | null = element;
        while (node && parts.length < 6) {
          if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift("#" + CSS.escape(node.id)); break; }
          const parent: Element | null = node.parentElement;
          const tag: string = node.tagName.toLowerCase();
          if (!parent) { parts.unshift(tag); break; }
          const same = [...parent.children].filter((child) => child.tagName === node!.tagName);
          parts.unshift(tag + (same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : ""));
          node = parent;
        }
        const rect = element.getBoundingClientRect();
        return { selector: parts.join(" > "), visible: rect.width > 0 && rect.height > 0, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }, point);
      if (!selection?.visible || !selection.selector || await page.locator(selection.selector).count() !== 1) throw new HttpError(422, "A unique visible region could not be selected");
      checkDimensions({ width: Math.ceil(selection.width), height: Math.ceil(selection.height) }, { width: cfg.MAX_CAPTURE_WIDTH, height: cfg.MAX_CAPTURE_HEIGHT, pixels: cfg.MAX_CAPTURE_PIXELS });
    }
    return { image: image.toString("base64"), width: 1280, height: 900, selection };
  } catch (error) {
    throw regionPreviewFailure(error, stage);
  } finally {
    try { await browser?.close(); } finally { await proxy?.close(); }
  }
}
