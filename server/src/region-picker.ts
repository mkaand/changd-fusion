import { chromium, type Browser } from "playwright";
import { EgressPolicy, browserProxy } from "./egress.js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { checkDimensions, pngDimensions } from "./image.js";
import type { Monitor } from "./capture.js";

export async function previewRegion(m: Monitor, cfg: Config, point?: { x: number; y: number }, policy = new EgressPolicy()) {
  if (m.kind !== "browser" || !m.visual_enabled) throw new HttpError(422, "Visual browser capture is required");
  if ((m.browser_steps ?? []).some((step) => step.action === "fill_private")) throw new HttpError(422, "Region preview does not use private values");
  await policy.target(m.url);
  const proxy = await browserProxy(policy);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH, proxy: { server: proxy.url, bypass: "<-loopback>" }, timeout: cfg.CAPTURE_TIMEOUT_MS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", serviceWorkers: "block", ignoreHTTPSErrors: false });
    await context.route("**/*", async (route) => { try { await policy.target(route.request().url()); await route.continue(); } catch { await route.abort("blockedbyclient"); } });
    const page = await context.newPage();
    const response = await page.goto(m.url, { waitUntil: "domcontentloaded", timeout: cfg.CAPTURE_TIMEOUT_MS });
    if (!response?.ok()) throw new HttpError(422, "Website preview could not be loaded");
    await page.addStyleTag({ content: "* { animation:none !important; transition:none !important; caret-color:transparent !important; }" });
    const image = await page.screenshot({ type: "png", animations: "disabled", timeout: cfg.CAPTURE_TIMEOUT_MS });
    pngDimensions(image, { width: cfg.MAX_CAPTURE_WIDTH, height: cfg.MAX_CAPTURE_HEIGHT, pixels: cfg.MAX_CAPTURE_PIXELS });
    let selection: { selector: string; visible: boolean; x: number; y: number; width: number; height: number } | null = null;
    if (point) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > 1280 || point.y > 900) throw new HttpError(422, "Invalid preview point");
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
  } finally { try { await browser?.close(); } finally { await proxy.close(); } }
}
