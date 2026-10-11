import { chromium, type Browser, type Locator } from "playwright";
import { EgressPolicy, browserProxy, safeFetch } from "./egress.js";
import { normalizeText } from "./comparison.js";
import { locate, runSteps, type BrowserStep } from "./browser-steps.js";
import { AttentionFailure, detectAttention } from "./attention.js";
import {
  CaptureFailure,
  captureFailure,
  type CaptureStage,
  HttpError,
} from "./errors.js";
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
  capture_selector_type?: "css" | "xpath";
  browser_steps?: BrowserStep[];
  step_budget_ms?: number;
  private_values?: Record<string, string>;
  paused?: boolean;
  monitor_state?: string;
  notify_failures?: boolean;
  notify_attention?: boolean;
  notification_enabled?: boolean;
  muted_until?: string | null;
  notification_cooldown_seconds?: number;
  notification_mode?: "immediate" | "digest";
  digest_window_seconds?: number;
  visual_threshold: string;
  pixel_threshold: string;
  interval_seconds: number;
  baseline_id: string | null;
  latest_capture_id: string | null;
  browser_text_extraction_version?: number;
  failure_count: number;
};
export type Capture = {
  text: string | null;
  screenshot: Buffer | null;
  warning?: string;
};

// This runs only as part of our fixed capture implementation; monitors cannot
// provide arbitrary JavaScript. It preserves DOM order without mutating the
// document that will also be used by visual capture.
async function visibleText(locator: Locator, ignoreSelectors: string[]) {
  // Fixed page code only: monitors cannot provide arbitrary JavaScript. Traverse
  // text nodes without mutating the page that the visual capture reuses.
  return await locator.evaluateAll((selected, ignored) => {
    const roots: Element[] = [];
    root: for (const node of selected) {
      for (const parent of selected)
        if (parent !== node && parent.contains(node)) continue root;
      roots.push(node);
    }
    const excludedTags = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
    const chunks: string[] = [];
    for (const root of roots) {
      // Check each element once and prune hidden subtrees. The previous
      // text-node/ancestor walk called getComputedStyle repeatedly for large
      // application pages, which could consume the whole capture budget.
      const pending: Node[] = [root];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.nodeType === Node.TEXT_NODE) {
          chunks.push(node.nodeValue ?? "");
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const element = node as Element;
        if (
          excludedTags.has(element.tagName) ||
          element.hasAttribute("hidden") ||
          ignored.some((selector) => element.matches(selector))
        )
          continue;
        const style = window.getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.contentVisibility === "hidden" ||
          style.opacity === "0"
        )
          continue;
        for (let index = element.childNodes.length - 1; index >= 0; index--)
          pending.push(element.childNodes[index]);
      }
    }
    return chunks.join("\n");
  }, ignoreSelectors);
}
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
  let stage: CaptureStage = "target_validation";
  let proxy: Awaited<ReturnType<typeof browserProxy>> | undefined;
  let browser: Browser | undefined;
  let timer: NodeJS.Timeout | undefined;
  let deadlineElapsed = false;
  try {
    await policy.target(m.url);
    if (m.kind !== "browser") {
      stage = "navigation";
      const response = await safeFetch(m.url, policy, cfg.CAPTURE_TIMEOUT_MS);
      const text =
        m.kind === "api"
          ? JSON.stringify(stableJSON(JSON.parse(response.body.toString())), null, 2)
          : response.body.toString();
      return { text: normalizeText(text, m), screenshot: null };
    }
    const privateValues = m.private_values ?? {};
    const privateWorkflow = (m.browser_steps ?? []).some(
      (s) => s.action === "fill_private",
    );
    if (
      privateWorkflow &&
      (m.visual_enabled || new URL(m.url).protocol !== "https:")
    )
      throw new HttpError(
        422,
        "Private workflows require HTTPS and text-only capture",
      );
    proxy = await browserProxy(policy);
    stage = "browser_launch";
    browser = await chromium.launch({
      headless: true,
      timeout: Math.max(1, deadline - Date.now()),
      chromiumSandbox: true,
      executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
    });
    stage = "browser_context";
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
    timer = setTimeout(() => {
      deadlineElapsed = true;
      void context.close().catch(() => {});
    }, Math.max(1, deadline - Date.now()));
    context.setDefaultTimeout(Math.min(cfg.CAPTURE_TIMEOUT_MS, 10000));
    await context.route("**/*", async (route) => {
      try {
        const requested = route.request().url();
        if (
          privateWorkflow &&
          new URL(requested).origin !== new URL(m.url).origin
        )
          throw Error();
        await policy.target(requested);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    await context.routeWebSocket("**/*", (ws) => ws.close());
    stage = "navigation";
    const page = await context.newPage();
    let navigationStatus = 200;
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame())
        navigationStatus = r.status();
    });
    const response = await page.goto(m.url, {
      waitUntil: "domcontentloaded",
      timeout: cfg.CAPTURE_TIMEOUT_MS,
    });
    if (!response) throw Error("Capture navigation failed");
    if (!response.ok())
      throw (
        detectAttention(
          response.status(),
          new URL(page.url()).pathname,
          "",
          false,
          false,
        ) ??
        new HttpError(422, "Website returned an unsuccessful HTTP response")
      );
    stage = "browser_steps";
    const warning = await runSteps(
      page,
      m.browser_steps ?? [],
      Math.min(deadline, Date.now() + (m.step_budget_ms ?? 20000)),
      privateValues,
    );
    stage = "attention_detection";
    const attention = detectAttention(
      navigationStatus,
      new URL(page.url()).pathname,
      await page.title(),
      (await page.locator('input[type="password"]').count()) > 0,
      (await page
        .locator(
          'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-challenge, #challenge-running, [data-sitekey]',
        )
        .count()) > 0,
    );
    if (attention) throw attention;
    stage = "font_wait";
    await page.evaluate(() => document.fonts.ready);
    stage = "text_extraction";
    const locator = m.selector
      ? m.selector_type === "xpath"
        ? page.locator("xpath=" + m.selector)
        : locate(page, m.selector)
      : page.locator("body");
    let extracted = m.text_enabled
      ? await visibleText(locator, m.ignore_selectors)
      : "";
    for (const value of Object.values(privateValues))
      extracted = extracted.split(value).join("[private]");
    const text = m.text_enabled ? normalizeText(extracted, m) : null;
    if (m.text_enabled && m.selector && (await locator.count()) === 0)
      throw new HttpError(422, "Extraction selector matched no elements");
    // Freeze animations and use the same page for DOM and all screenshot modes.
    let screenshot: Buffer | null = null;
    if (m.visual_enabled) {
      stage = "screenshot";
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
        mask: m.mask_selectors.map((s) =>
          s.startsWith("xpath=") ? page.locator(s) : locate(page, s),
        ),
      };
      if (m.capture_mode === "element") {
        const region = locate(
          page,
          m.capture_selector,
          m.capture_selector_type,
        );
        if ((await region.count()) !== 1)
          throw new HttpError(
            422,
            "Capture selector must match exactly one element",
          );
        if (!(await region.isVisible()))
          throw new HttpError(422, "Capture region is not visible");
        await region.scrollIntoViewIfNeeded();
        const bounds = await region.boundingBox();
        if (!bounds) throw new HttpError(422, "Capture region is not visible");
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
    return { text, screenshot, warning };
  } catch (error) {
    if (error instanceof AttentionFailure) throw error;
    if (deadlineElapsed)
      throw new CaptureFailure(stage, "timeout");
    throw captureFailure(error, stage);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await browser?.close();
    } finally {
      await proxy?.close();
    }
  }
}
