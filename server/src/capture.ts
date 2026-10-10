import { chromium, type Browser } from "playwright";
import { EgressPolicy, browserProxy, safeFetch } from "./egress.js";
import { normalizeText } from "./comparison.js";
import { checkDimensions, pngDimensions } from "./image.js";
import type { Config } from "./config.js";
export type Monitor = {
  id: string;
  user_id: string;
  name: string;
  url: string;
  kind: "browser" | "html" | "api";
  text_enabled: boolean;
  visual_enabled: boolean;
  selector: string;
  selector_type: "css" | "xpath";
  ignore_selectors: string[];
  mask_selectors: string[];
  ignore_text: string[];
  normalize_whitespace: boolean;
  ignore_case: boolean;
  capture_mode: "viewport" | "full_page" | "element";
  capture_selector: string;
  visual_threshold: string;
  pixel_threshold: string;
  interval_seconds: number;
  baseline_id: string | null;
  latest_capture_id: string | null;
  failure_count: number;
};
export type Capture = { text: string | null; screenshot: Buffer | null };
function stableJSON(value: any): any {
  if (Array.isArray(value)) return value.map(stableJSON);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stableJSON(value[k])]),
    );
  return value;
}
export async function capture(
  m: Monitor,
  cfg: Config,
  policy = new EgressPolicy(),
): Promise<Capture> {
  const deadline = Date.now() + cfg.CAPTURE_TIMEOUT_MS;
  await policy.target(m.url);
  if (m.kind !== "browser") {
    const response = await safeFetch(m.url, policy, cfg.CAPTURE_TIMEOUT_MS);
    const text =
      m.kind === "api"
        ? JSON.stringify(
            stableJSON(JSON.parse(response.body.toString())),
            null,
            2,
          )
        : response.body.toString();
    return { text: normalizeText(text, m), screenshot: null };
  }
  const proxy = await browserProxy(policy);
  let browser: Browser | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      timeout: Math.max(1, deadline - Date.now()),
      chromiumSandbox: true,
      executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
      colorScheme: "light",
      serviceWorkers: "block",
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    timer = setTimeout(
      () => void context.close().catch(() => {}),
      Math.max(1, deadline - Date.now()),
    );
    context.setDefaultTimeout(Math.min(cfg.CAPTURE_TIMEOUT_MS, 10000));
    await context.route("**/*", async (route) => {
      try {
        await policy.target(route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket("**/*", (ws) => ws.close());
    const page = await context.newPage();
    const response = await page.goto(m.url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.CAPTURE_TIMEOUT_MS,
    });
    if (!response || !response.ok()) throw Error("Capture navigation failed");
    await page.evaluate(() => document.fonts.ready);
    for (const selector of m.ignore_selectors)
      await page
        .locator(selector)
        .evaluateAll((nodes) => nodes.forEach((n) => n.remove()));
    const locator = m.selector
      ? m.selector_type === "xpath"
        ? page.locator("xpath=" + m.selector)
        : page.locator(m.selector)
      : page.locator("body");
    const text = m.text_enabled
      ? normalizeText((await locator.allTextContents()).join("\n"), m)
      : null;
    if (m.text_enabled && m.selector && (await locator.count()) === 0)
      throw Error("Extraction selector matched no elements");
    // Freeze animations and use the same page for DOM and all screenshot modes.
    let screenshot: Buffer | null = null;
    if (m.visual_enabled) {
      await page.addStyleTag({
        content:
          "* { animation: none !important; transition: none !important; caret-color: transparent !important; }",
      });
      const limits = {
        width: cfg.MAX_CAPTURE_WIDTH,
        height: cfg.MAX_CAPTURE_HEIGHT,
        pixels: cfg.MAX_CAPTURE_PIXELS,
      };
      const options = {
        type: "png" as const,
        animations: "disabled" as const,
        timeout: Math.max(1, deadline - Date.now()),
        mask: m.mask_selectors.map((s) => page.locator(s)),
      };
      if (m.capture_mode === "element") {
        const region = page.locator(m.capture_selector);
        if ((await region.count()) !== 1)
          throw Error("Capture selector must match exactly one element");
        await region.scrollIntoViewIfNeeded();
        const bounds = await region.boundingBox();
        if (!bounds) throw Error("Capture region is not visible");
        checkDimensions(
          { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) },
          limits,
        );
        screenshot = await region.screenshot(options);
      } else {
        const size =
          m.capture_mode === "full_page"
            ? await page.evaluate(() => ({
                width: Math.max(
                  document.documentElement.scrollWidth,
                  document.body.scrollWidth,
                  1280,
                ),
                height: Math.max(
                  document.documentElement.scrollHeight,
                  document.body.scrollHeight,
                  900,
                ),
              }))
            : { width: 1280, height: 900 };
        checkDimensions(size, limits);
        screenshot = await page.screenshot({
          ...options,
          fullPage: m.capture_mode === "full_page",
        });
      }
      pngDimensions(screenshot, limits);
    }
    if (text && text.length > 2_000_000)
      throw Error("Extracted text too large");
    return { text, screenshot };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await browser?.close();
    } finally {
      await proxy.close();
    }
  }
}
