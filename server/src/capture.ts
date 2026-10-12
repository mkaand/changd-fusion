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
import { canonicalProductPrice, extractProductPrice, jinaReaderText } from "./price-extraction.js";
import { applySelectedTextRule, readableJinaLines, type SelectedTextRule } from "./selected-text.js";
export type Monitor = {
  id: string;
  user_id: string;
  name: string;
  url: string;
  kind: "browser" | "html" | "api";
  text_enabled: boolean;
  text_direction?: "added" | "removed" | "both";
  text_source?: "direct" | "jina";
  extraction_mode?: "full_text" | "product_price" | "selected_text";
  extraction_rule?: SelectedTextRule | null;
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
  // In-memory timing only. It is intentionally not persisted with captures.
  timings?: Partial<Record<CaptureStage, number>>;
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
export function validateJinaReaderContent(body: Buffer) {
  const text = jinaReaderText(body.toString("utf8"));
  const compact = text.replace(/\s+/g, " ").toLowerCase();
  const challenge = /(?:just a moment\.{0,3}|performing security verification|verify you are human|complete (?:the )?captcha|cloudflare challenge|bot verification)/.test(compact);
  const accessFailure = /(?:access denied|forbidden|request failed|error 10\d{2})/.test(compact);
  const errorDocument = /^(?:error|forbidden|access denied|request failed)\b/.test(compact) || /<(?:html|title)[^>]*>.*(?:captcha|cloudflare|access denied|forbidden)/i.test(text);
  // A normal article can mention CAPTCHA or Cloudflare. Only block compact
  // interstitial/error documents with an independent failure signal.
  if (!text || (text.length < 600 && (accessFailure || challenge)) || (challenge && accessFailure)) throw new HttpError(422, "Reader content could not be verified. Keep the existing baseline and retry.");
  return text;
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
  const timings: Partial<Record<CaptureStage, number>> = {};
  let stageStarted = performance.now();
  const enterStage = (next: CaptureStage) => {
    timings[stage] = (timings[stage] ?? 0) + performance.now() - stageStarted;
    stage = next;
    stageStarted = performance.now();
  };
  const finishTimings = () => {
    timings[stage] = (timings[stage] ?? 0) + performance.now() - stageStarted;
  };
  let proxy: Awaited<ReturnType<typeof browserProxy>> | undefined;
  let browser: Browser | undefined;
  let timer: NodeJS.Timeout | undefined;
  let deadlineElapsed = false;
  try {
    await policy.target(m.url);
    if (m.kind !== "browser") {
      enterStage("navigation");
      const response = await safeFetch(m.text_source === "jina" ? `https://r.jina.ai/${m.url}` : m.url, policy, cfg.CAPTURE_TIMEOUT_MS);
      const text =
        m.kind === "api"
          ? JSON.stringify(stableJSON(JSON.parse(response.body.toString())), null, 2)
          : response.body.toString();
      finishTimings();
      return { text: normalizeText(text, m), screenshot: null, timings };
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
    if (m.text_source === "jina" && m.text_enabled && !m.visual_enabled) {
      enterStage("navigation");
      const response = await safeFetch(`https://r.jina.ai/${m.url}`, policy, cfg.CAPTURE_TIMEOUT_MS);
      enterStage("text_extraction");
      const readerText = validateJinaReaderContent(response.body);
      const text = m.extraction_mode === "product_price"
        ? canonicalProductPrice(extractProductPrice(readerText))
        : m.extraction_mode === "selected_text"
          ? normalizeText(applySelectedTextRule(readableJinaLines(readerText).join("\n"), m.extraction_rule!), { ...m, ignore_text: [], ignore_case: false, normalize_whitespace: true })
          : normalizeText(readerText, m);
      finishTimings();
      return { text, screenshot: null, timings };
    }
    proxy = await browserProxy(policy);
    enterStage("browser_launch");
    browser = await chromium.launch({
      headless: true,
      timeout: Math.max(1, deadline - Date.now()),
      chromiumSandbox: true,
      executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH,
      proxy: { server: proxy.url, bypass: "<-loopback>" },
    });
    enterStage("browser_context");
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
    enterStage("navigation");
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
    enterStage("browser_steps");
    const warning = await runSteps(
      page,
      m.browser_steps ?? [],
      Math.min(deadline, Date.now() + (m.step_budget_ms ?? 20000)),
      privateValues,
    );
    enterStage("attention_detection");
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
    // Font readiness can wait for third-party font downloads until the global
    // capture deadline. Text-only monitors compare DOM text, so font rasterization
    // cannot affect their result; visual captures keep the existing wait.
    if (m.visual_enabled) {
      enterStage("font_wait");
      // Third-party web fonts are optional rendering preparation. A stalled
      // font must not consume the shared capture deadline.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(1500, Math.max(1, deadline - Date.now())));
        void page.evaluate(() => document.fonts.ready).then(
          () => { clearTimeout(timer); resolve(); },
          () => { clearTimeout(timer); resolve(); },
        );
      });
    }
    enterStage("text_extraction");
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
      enterStage("screenshot");
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
        // locator.screenshot performs another potentially long actionability
        // wait. Resolve a stable, validated box and use the bounded page
        // screenshot path shared by the other capture modes instead.
        const boxes = await Promise.all([
          region.boundingBox(),
          page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))).then(() => region.boundingBox()),
        ]);
        const bounds = boxes[1];
        if (!bounds) throw new HttpError(422, "Capture region is not visible");
        if (!boxes[0] || Math.abs(boxes[0].x - bounds.x) > 1 || Math.abs(boxes[0].y - bounds.y) > 1 || Math.abs(boxes[0].width - bounds.width) > 1 || Math.abs(boxes[0].height - bounds.height) > 1)
          throw new HttpError(422, "Capture region is still moving. Retry after the page settles.");
        checkDimensions(
          { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) },
          limits,
        );
        screenshot = await page.screenshot({ ...options, clip: bounds });
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
    finishTimings();
    return { text, screenshot, warning, timings };
  } catch (error) {
    finishTimings();
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
