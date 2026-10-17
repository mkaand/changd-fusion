import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { EgressPolicy, browserProxy, safeFetch, type SafeFetchOptions } from "./egress.js";
import { normalizeText } from "./comparison.js";
import { locate, runSteps, type BrowserStep } from "./browser-steps.js";
import { AttentionFailure, detectAttention } from "./attention.js";
import {
  CaptureFailure,
  captureFailure,
  type CaptureStage,
  type CaptureTimings,
  HttpError,
  WorkerFatalError,
} from "./errors.js";
import { checkDimensions, pngDimensions } from "./image.js";
import type { Config } from "./config.js";
import { jinaReaderText } from "./jina-reader.js";
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
  extraction_mode?: "full_text" | "selected_text" | "keyword_presence";
  keyword?: string | null;
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
  // Numeric-only stage timings; the engine persists this bounded diagnostic
  // map without URLs, selectors, page content, or raw provider errors.
  timings?: CaptureTimings;
};

export const CAPTURE_CLEANUP_TIMEOUT_MS = 5_000;

export async function closeWithDeadline(close: (() => Promise<void>) | undefined, timeoutMs = CAPTURE_CLEANUP_TIMEOUT_MS): Promise<boolean> {
  if (!close) return true;
  let timer: NodeJS.Timeout | undefined;
  const closing = Promise.resolve().then(close);
  void closing.catch(() => {});
  try {
    return await Promise.race([
      closing.then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function shouldBypassJinaCache(m: Pick<Monitor, "text_source" | "extraction_mode">) {
  return m.text_source === "jina" && m.extraction_mode === "selected_text";
}

export function jinaReaderFetchOptions(m: Pick<Monitor, "text_source" | "extraction_mode">): SafeFetchOptions {
  return { jinaNoCache: shouldBypassJinaCache(m) };
}

function fetchJinaReader(m: Pick<Monitor, "url" | "text_source" | "extraction_mode">, policy: EgressPolicy, timeout: number) {
  return safeFetch(`https://r.jina.ai/${m.url}`, policy, timeout, 2_000_000, jinaReaderFetchOptions(m));
}

async function cdpScreenshot(context: BrowserContext, page: Page, clip?: { x: number; y: number; width: number; height: number }) {
  const cdp = await context.newCDPSession(page);
  try {
    const captured = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: Boolean(clip),
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    return Buffer.from(captured.data, "base64");
  } finally { await cdp.detach().catch(() => {}); }
}

export function isElementFullyInViewport(
  bounds: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number } | null,
): boolean {
  return Boolean(bounds && viewport &&
    [bounds.x, bounds.y, bounds.width, bounds.height, viewport.width, viewport.height].every(Number.isFinite) &&
    bounds.width > 0 && bounds.height > 0 &&
    bounds.x >= 0 && bounds.y >= 0 &&
    bounds.x + bounds.width <= viewport.width &&
    bounds.y + bounds.height <= viewport.height);
}

type ElementBounds = { x: number; y: number; width: number; height: number };

// A locator bounding box is relative to the viewport but does not include
// clipping imposed by overflow ancestors. Keep this check in the page so an
// unobscured document-space target is not mistaken for a clipped capture
// region; CDP can still capture a valid target beyond the viewport.
export async function elementCaptureViewportState(
  region: Locator,
): Promise<{ bounds: ElementBounds | null; needsScroll: boolean; clippedByAncestor: boolean }> {
  return await region.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const finite = [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite);
    if (
      !finite ||
      bounds.width <= 0 ||
      bounds.height <= 0
    )
      return { bounds: finite ? bounds : null, needsScroll: true, clippedByAncestor: true };

    // The client box is the area that descendants may paint into.  Check only
    // axes that the ancestor actually clips; overflow:hidden remains eligible
    // for native programmatic scrolling, while overflow:clip is revalidated
    // after that attempt and deterministically rejected if it cannot reveal
    // the entire target.
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      const clipsX = /^(?:auto|scroll|hidden|clip|overlay)$/.test(style.overflowX);
      const clipsY = /^(?:auto|scroll|hidden|clip|overlay)$/.test(style.overflowY);
      if (!clipsX && !clipsY) continue;
      const container = ancestor.getBoundingClientRect();
      const left = container.left + ancestor.clientLeft;
      const top = container.top + ancestor.clientTop;
      const right = left + ancestor.clientWidth;
      const bottom = top + ancestor.clientHeight;
      if (
        (clipsX && (rect.left < left || rect.right > right)) ||
        (clipsY && (rect.top < top || rect.bottom > bottom))
      )
        return { bounds, needsScroll: true, clippedByAncestor: true };
    }
    // CDP captures a document-space clip with captureBeyondViewport enabled.
    // A target larger than the viewport is therefore valid when no overflow
    // ancestor clips it. Keep scrolling for smaller offscreen elements (which
    // may trigger lazy content), but do not require an impossible full fit.
    const fitsViewport = bounds.width <= window.innerWidth && bounds.height <= window.innerHeight;
    const withinViewport =
      bounds.x >= 0 && bounds.y >= 0 &&
      bounds.x + bounds.width <= window.innerWidth &&
      bounds.y + bounds.height <= window.innerHeight;
    return { bounds, needsScroll: fitsViewport && !withinViewport, clippedByAncestor: false };
  });
}

export async function navigateForCapture(page: Page, url: string, deadline: number) {
  // Inspect the final HTTP redirect response as soon as it commits. An error
  // document must not spend the capture budget loading scripts before rejection.
  // Successful documents still require DOMContentLoaded: commit alone is not
  // evidence that parsing, deferred scripts or application initialization finished.
  const response = await page.goto(url, {
    waitUntil: "commit",
    timeout: Math.max(1, deadline - Date.now()),
  });
  if (!response) throw Error("Capture navigation failed");
  if (!response.ok())
    throw (detectAttention(response.status(), new URL(page.url()).pathname, "", false, false) ??
      new HttpError(422, "Website returned an unsuccessful HTTP response"));
  await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) });
}

export async function scrollCaptureRegion(region: Locator) {
  // Visibility and uniqueness are checked by the caller. Native instant scroll
  // handles nested scroll containers without Playwright's redundant pre-scroll
  // stability wait. The capture still requires stable bounds AFTER scrolling.
  await region.evaluate((element) => element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }));
}

const boxIsClose = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) =>
  Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;

export async function stableElementBounds(
  sample: () => Promise<{ x: number; y: number; width: number; height: number } | null>,
  nextFrame: () => Promise<void>,
  deadline: number,
  initial?: { x: number; y: number; width: number; height: number } | null,
) {
  let previous = initial === undefined ? await sample() : initial, bounds = previous;
  for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
    await nextFrame();
    const current = await sample();
    if (previous && current && boxIsClose(previous, current)) return current;
    previous = current;
    bounds = current;
  }
  return bounds ? null : undefined;
}

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
  const timings: CaptureTimings = {};
  let stageStarted = performance.now();
  const enterStage = (next: CaptureStage) => {
    timings[stage] = Math.round((timings[stage] ?? 0) + performance.now() - stageStarted);
    stage = next;
    stageStarted = performance.now();
  };
  const finishTimings = () => {
    const now = performance.now();
    timings[stage] = Math.round((timings[stage] ?? 0) + now - stageStarted);
    // catch/return records the active stage before finally enters cleanup.
    // Advance the checkpoint so that transition cannot count this work twice.
    stageStarted = now;
  };
  let proxy: Awaited<ReturnType<typeof browserProxy>> | undefined;
  let browser: Browser | undefined;
  let timer: NodeJS.Timeout | undefined;
  let deadlineElapsed = false;
  try {
    await policy.target(m.url);
    if (m.kind !== "browser") {
      enterStage("navigation");
      const response = m.text_source === "jina"
        ? await fetchJinaReader(m, policy, cfg.CAPTURE_TIMEOUT_MS)
        : await safeFetch(m.url, policy, cfg.CAPTURE_TIMEOUT_MS);
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
      const response = await fetchJinaReader(m, policy, cfg.CAPTURE_TIMEOUT_MS);
      enterStage("text_extraction");
      const readerText = validateJinaReaderContent(response.body);
      const text = m.extraction_mode === "selected_text"
          ? normalizeText(applySelectedTextRule(readableJinaLines(readerText).join("\n"), m.extraction_rule!), { ...m, ignore_text: [], ignore_case: false, normalize_whitespace: true })
          : normalizeText(readerText, m);
      finishTimings();
      return { text, screenshot: null, timings };
    }
    enterStage("proxy_initialization");
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
    // The pinned-IP proxy validates every redirect and subresource at socket
    // connection time. Keep only the stricter same-origin rule needed by
    // private workflows; duplicating DNS validation for every normal request
    // adds avoidable navigation latency without strengthening egress safety.
    if (privateWorkflow) await context.route("**/*", async (route) => {
      try {
        const requested = route.request().url();
        if (new URL(requested).origin !== new URL(m.url).origin) throw Error();
        await route.continue();
      } catch { await route.abort("blockedbyclient"); }
    });
    await context.routeWebSocket("**/*", (ws) => ws.close());
    enterStage("navigation");
    const page = await context.newPage();
    let navigationStatus = 200;
    page.on("response", (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame())
        navigationStatus = r.status();
    });
    await navigateForCapture(page, m.url, deadline);
    enterStage("browser_steps");
    const warning = await runSteps(
      page,
      m.browser_steps ?? [],
      Math.min(deadline, Date.now() + (m.step_budget_ms ?? 20000)),
      privateValues,
    );
    enterStage("attention_detection");
    // One bounded DOM round-trip instead of three independent title/locator calls.
    const attentionSignals = await page.evaluate(() => ({
      title: document.title,
      password: Boolean(document.querySelector('input[type="password"]')),
      challenge: Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-challenge, #challenge-running, [data-sitekey]')),
    }));
    const attention = detectAttention(
      navigationStatus,
      new URL(page.url()).pathname,
      attentionSignals.title,
      attentionSignals.password,
      attentionSignals.challenge,
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
        enterStage("selector_lookup");
        const region = locate(
          page,
          m.capture_selector,
          m.capture_selector_type,
        );
        const count = await region.count();
        if (count === 0) throw new CaptureFailure("selector_lookup", "selector_missing", "Capture selector matched no element.");
        if (count !== 1) throw new CaptureFailure("selector_lookup", "selector_ambiguous", "Capture selector must match exactly one element.");
        enterStage("visibility_validation");
        if (!(await region.isVisible()))
          throw new CaptureFailure("visibility_validation", "element_not_visible", "Capture region is not visible.");
        enterStage("scroll_into_view");
        // Playwright scroll actionability can be slow even when the element is
        // fully on screen. Preserve the existing scroll for offscreen/lazy
        // content, but avoid it when the current bounds are already visible.
        const initial = await elementCaptureViewportState(region);
        if (initial.needsScroll) await scrollCaptureRegion(region);
        // scrollIntoView() may not be able to reveal a target inside
        // overflow:clip.  Do not rasterize the clipping background as if it
        // were a complete element screenshot.
        const afterScroll = initial.needsScroll ? await elementCaptureViewportState(region) : initial;
        if (afterScroll.clippedByAncestor)
          throw new CaptureFailure("visibility_validation", "element_not_visible", "Capture region is clipped and cannot be fully revealed.");
        // locator.screenshot performs another potentially long actionability
        // wait. Resolve a stable, validated box and use the bounded page
        // screenshot path shared by the other capture modes instead.
        enterStage("element_stability");
        // Sequential samples avoid the overlapping measurements that rejected
        // harmless single-frame layout movement. The window remains strictly
        // bounded and still requires two consecutive equivalent boxes.
        const bounds = await stableElementBounds(
          () => region.boundingBox(),
          () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))),
          deadline,
          afterScroll.bounds,
        );
        if (bounds === undefined) throw new CaptureFailure("element_stability", "element_not_visible", "Capture region is not visible.");
        if (bounds === null) throw new CaptureFailure("element_stability", "element_unstable", "Capture region did not become stable in the bounded sampling window.");
        checkDimensions(
          { width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) },
          limits,
        );
        enterStage("screenshot_rasterization");
        const viewport = page.viewportSize();
        const exceedsViewport = Boolean(viewport && (bounds.width > viewport.width || bounds.height > viewport.height));
        // Chromium's direct CDP clipping is the lower-overhead path for normal
        // element captures. In the sandboxed Chromium runtime, however, its
        // captureBeyondViewport flag can still truncate a clip larger than the
        // active viewport. Playwright's native clipped screenshot path handles
        // that valid, already dimension-checked case without adding locator
        // actionability waits. Keep it limited to oversize targets (and masks).
        if (m.mask_selectors.length || exceedsViewport) screenshot = await page.screenshot({ ...options, clip: bounds });
        else {
          const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
          screenshot = await cdpScreenshot(context, page, { x: bounds.x + scroll.x, y: bounds.y + scroll.y, width: bounds.width, height: bounds.height });
        }
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
        enterStage("screenshot_rasterization");
        screenshot = m.capture_mode === "viewport" && !m.mask_selectors.length
          ? await cdpScreenshot(context, page)
          : await page.screenshot({ ...options, fullPage: m.capture_mode === "full_page" });
      }
      enterStage("image_validation");
      pngDimensions(screenshot, limits);
    }
    if (text && text.length > 2_000_000)
      throw Error("Extracted text too large");
    finishTimings();
    return { text, screenshot, warning, timings };
  } catch (error) {
    finishTimings();
    if (error instanceof WorkerFatalError) { error.timings = timings; throw error; }
    if (error instanceof AttentionFailure) { error.timings = timings; throw error; }
    const failure = deadlineElapsed
      ? new CaptureFailure(stage, (stage as string) === "screenshot_rasterization" ? "screenshot_timeout" : "timeout")
      : captureFailure(error, stage);
    failure.timings = timings;
    throw failure;
  } finally {
    if (timer) clearTimeout(timer);
    enterStage("cleanup");
    const browserToClose = browser;
    const proxyToClose = proxy;
    const browserClosed = await closeWithDeadline(browserToClose ? () => browserToClose.close() : undefined);
    const proxyClosed = await closeWithDeadline(proxyToClose ? () => proxyToClose.close() : undefined);
    finishTimings();
    if (!browserClosed) throw new WorkerFatalError("browser", timings);
    if (!proxyClosed) throw new WorkerFatalError("proxy", timings);
  }
}
