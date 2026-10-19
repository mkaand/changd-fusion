import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { EgressPolicy, browserProxy } from "./egress.js";
import type { Config } from "./config.js";
import { CaptureFailure, HttpError, captureFailure, type CaptureFailureCode, type CaptureStage } from "./errors.js";
import { checkDimensions, pngDimensions } from "./image.js";
import type { Monitor } from "./capture.js";
import type { ChromiumLease } from "./chromium-capacity.js";
import { runSteps } from "./browser-steps.js";

type RegionPreviewCode = CaptureFailureCode | "session_expired" | "stale_preview" | "ambiguous_selection";
export type RegionPreviewFailure = { stage: CaptureStage; failure_code: RegionPreviewCode; status: number; message: string };
type Selection = { selector: string; label: string; visible: boolean; x: number; y: number; width: number; height: number };
export type PreviewStage = "target_validation" | "capacity_wait" | "proxy_initialization" | "browser_launch" | "browser_context" | "navigation" | "dom_ready" | "browser_steps" | "rendering_preparation" | "screenshot" | "serialization" | "ready";
type PreviewTimings = Partial<Record<PreviewStage, number>>;
type Session = { id: string; ownerId: string; createdAt: number; expiresAt: number; expiryTimer?: NodeJS.Timeout; closing?: Promise<void>; browser: Browser; context: BrowserContext; page: Page; proxy: Awaited<ReturnType<typeof browserProxy>>; capacity?: ChromiumLease; image: Buffer; timings: PreviewTimings };
type PreviewOperations = {
  snapshot?: (page: Page) => Promise<void>;
  screenshot?: (context: BrowserContext, page: Page) => Promise<Buffer>;
};
export const REGION_PREVIEW_MAX_LIFETIME_MS = 45_000;
// Keep admission plus browser work below the frontend's 125-second request
// timeout, leaving a small transport margin. Chromium still receives exactly
// CAPTURE_TIMEOUT_MS after it acquires capacity.
export const PREVIEW_REQUEST_BUDGET_MS = 120_000;
export function previewCapacityWaitBudget(cfg: Pick<Config, "CAPTURE_TIMEOUT_MS" | "PREVIEW_CAPACITY_WAIT_MS">) {
  return Math.min(cfg.PREVIEW_CAPACITY_WAIT_MS, Math.max(0, PREVIEW_REQUEST_BUDGET_MS - cfg.CAPTURE_TIMEOUT_MS));
}
const MAX_SESSIONS = 4;
const sessions = new Map<string, Session>();
const reservations = new Map<string, string>();

function reserveSession(ownerId: string, replaceOwnerSession: boolean) {
  if ([...reservations.values()].includes(ownerId))
    throw new CaptureFailure("browser_launch", "capacity_busy", "Preview capacity is busy. Retry shortly.");
  const existing = replaceOwnerSession
    ? [...sessions.values()].find((entry) => entry.ownerId === ownerId)
    : undefined;
  if (sessions.size + reservations.size - (existing ? 1 : 0) >= MAX_SESSIONS)
    throw new CaptureFailure("browser_launch", "capacity_busy", "Preview capacity is busy. Retry shortly.");
  if (existing) sessions.delete(existing.id);
  const token = randomUUID();
  reservations.set(token, ownerId);
  return { token, existing };
}

async function closeSession(session: Session) {
  if (session.closing) return session.closing;
  sessions.delete(session.id);
  if (session.expiryTimer) clearTimeout(session.expiryTimer);
  session.closing = (async () => {
    try { await session.context.close(); } catch {}
    try { await session.browser.close(); } catch {}
    await session.proxy.close().catch(() => {});
    await session.capacity?.release().catch(() => {});
  })();
  return session.closing;
}
async function purgeExpired(now = Date.now()) {
  await Promise.all([...sessions.values()].filter((session) => session.expiresAt <= now).map(closeSession));
}
const cleanup = setInterval(() => void purgeExpired(), 5_000);
cleanup.unref();
export async function closeRegionPreviewSessions() {
  await Promise.all([...sessions.values()].map(closeSession));
}
export async function releaseRegionPreviewSession(ownerId: string, sessionId: string) {
  await purgeExpired();
  const session = sessions.get(sessionId);
  // Missing and foreign sessions are deliberately indistinguishable. The
  // operation stays idempotent without exposing another owner's session.
  if (!session || session.ownerId !== ownerId) return false;
  await closeSession(session);
  return true;
}
export async function expireRegionPreviewSessions(now: number) { await purgeExpired(now); }

function previewMessage(stage: CaptureStage, code: RegionPreviewCode) {
  if (code === "session_expired") return "Preview expired. Refresh the preview and try again.";
  if (code === "stale_preview") return "The page changed after the screenshot. Refresh the preview before selecting.";
  if (code === "ambiguous_selection") return "The selected point does not identify one stable visible element. Try a nearby point.";
  if (code === "timeout") return "Preview timed out. Retry, or use viewport capture instead.";
  if (code === "capacity_busy") return "Preview capacity is busy. Retry shortly.";
  if (code === "capacity_wait_timeout") return "No browser capacity became available in time. Retry shortly.";
  if (code === "capacity_queue_full") return "Preview capacity is busy. Retry shortly.";
  if (code === "egress_denied") return "Preview destination is not permitted.";
  if (code === "selector_failed") return "The selected region is not a unique visible element.";
  if (stage === "navigation") return "Website preview could not be loaded. Check the URL and try again.";
  if (stage === "screenshot") return "Screenshot preview could not be created. Retry, or use viewport capture instead.";
  return "Website preview failed. Retry, or use viewport capture instead.";
}
export function regionPreviewFailure(error: unknown, stage: CaptureStage): RegionPreviewFailure {
  const safe = captureFailure(error, stage);
  const validation = error instanceof HttpError && error.status >= 400 && error.status < 500;
  const code: RegionPreviewCode = error instanceof HttpError && error.status === 410 ? "session_expired" : error instanceof HttpError && error.status === 409 ? "stale_preview" : error instanceof HttpError && /unique visible/i.test(error.message) ? "ambiguous_selection" : safe.code === "unknown" && stage === "text_extraction" ? "selector_failed" : safe.code;
  return { stage: safe.stage, failure_code: code, status: safe.code === "timeout" ? 504 : ["capacity_busy", "capacity_wait_timeout", "capacity_queue_full"].includes(safe.code) ? 429 : validation ? error.status : 422, message: previewMessage(safe.stage, code) };
}

export async function snapshotLayout(page: Page) {
  // tsx names nested helper functions with __name; define the inert helper in
  // the isolated page before installing our fixed, non-user-authored picker.
  await page.evaluate("window.__name = function(target) { return target; }");
  await page.evaluate(() => {
    const root = window as any;
    const rects: Record<string, { x: number; y: number; width: number; height: number; text: string }> = {};
    let sequence = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++sequence > 50_000) throw new Error("Preview DOM exceeds the safe element limit");
      const element = node as Element;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
      const id = `p${sequence}`;
      Object.defineProperty(element, "__changdPreviewId", { value: id, configurable: true });
      rects[id] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 256) };
    }
    root.__changdPreviewRects = rects;
  });
}

async function capturePreviewScreenshot(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  try {
    const captured = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    return Buffer.from(captured.data, "base64");
  } finally { await cdp.detach().catch(() => {}); }
}

async function boundedPreviewOperation<T>(input: {
  operation: () => Promise<T>;
  remaining: () => number;
  cancel: () => Promise<void>;
  stage: CaptureStage;
  signal?: AbortSignal;
}) {
  const budget = input.remaining();
  let interruption: HttpError | CaptureFailure | undefined;
  let cancelling: Promise<void> | undefined;
  const interrupt = (error: HttpError | CaptureFailure) => {
    if (interruption) return;
    interruption = error;
    cancelling = input.cancel();
  };
  const abort = () => interrupt(new HttpError(499, "Preview request was cancelled"));
  const timer = setTimeout(() => interrupt(new CaptureFailure(input.stage, "timeout")), budget);
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await input.operation();
    if (interruption) { await cancelling; throw interruption; }
    return result;
  } catch (error) {
    if (interruption) { await cancelling; throw interruption; }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}

export async function selectionAt(page: Page, point: { x: number; y: number }): Promise<{ selection: Selection; candidates: Selection[] }> {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > 1280 || point.y > 900)
    throw new HttpError(422, "Invalid preview point");
  const result = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;
    const snapshot = (window as any).__changdPreviewRects as Record<string, { x: number; y: number; width: number; height: number; text: string }> | undefined;
    const stableId = (value: string) => /^[A-Za-z][\w-]{0,63}$/.test(value) && !/(?:[a-f\d]{10,}|\d{6,})/i.test(value);
    const unique = (selector: string, target: Element) => { try { const found = document.querySelectorAll(selector); return found.length === 1 && found[0] === target; } catch { return false; } };
    const segment = (node: Element) => {
      const tag = node.tagName.toLowerCase();
      for (const name of ["data-testid", "data-test", "data-qa", "itemprop", "name", "aria-label"]) {
        const value = node.getAttribute(name);
        if (value && value.length <= 80) {
          const candidate = `${tag}[${name}="${CSS.escape(value)}"]`;
          if (unique(candidate, node)) return candidate;
        }
      }
      const classes = [...node.classList].filter((value) => value.length <= 40 && !/(?:[a-f\d]{10,}|\d{6,})/i.test(value)).slice(0, 3);
      for (const value of classes) { const candidate = `${tag}.${CSS.escape(value)}`; if (unique(candidate, node)) return candidate; }
      const parent = node.parentElement;
      if (!parent) return tag;
      const same = [...parent.children].filter((child) => child.tagName === node.tagName);
      return tag + (same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : "");
    };
    const selectorFor = (target: Element) => {
      if (target.id && stableId(target.id)) { const id = `#${CSS.escape(target.id)}`; if (unique(id, target)) return id; }
      const parts: string[] = [];
      let node: Element | null = target;
      for (let depth = 0; node && depth < 50; depth++, node = node.parentElement) {
        if (node.id && stableId(node.id)) { parts.unshift(`#${CSS.escape(node.id)}`); const candidate = parts.join(" > "); if (unique(candidate, target)) return candidate; }
        else parts.unshift(segment(node));
        const candidate = parts.join(" > ");
        if (unique(candidate, target)) return candidate;
      }
      return "";
    };
    const candidates: any[] = [];
    let node: Element | null = element;
    while (node && node !== document.documentElement && candidates.length < 6) {
      const marker = (node as any).__changdPreviewId as string | undefined;
      const previous = marker && snapshot?.[marker];
      const rect = node.getBoundingClientRect();
      if (!previous) { if (candidates.length) break; return { stale: true, candidates: [] }; }
      const currentText = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 256);
      const drifted = Math.abs(previous.x - rect.x) > 2 || Math.abs(previous.y - rect.y) > 2 || Math.abs(previous.width - rect.width) > 2 || Math.abs(previous.height - rect.height) > 2;
      // The exact hit must still correspond to the screenshot. Ancestor motion
      // only makes that parent unsuitable; it must not invalidate an accurate
      // exact child selection.
      if (!candidates.length && (drifted || previous.text !== currentText)) return { stale: true, candidates: [] };
      if (candidates.length && drifted) break;
      const selector = selectorFor(node);
      if (selector && rect.width > 0 && rect.height > 0 && !candidates.some((candidate) => candidate.x === previous.x && candidate.y === previous.y && candidate.width === previous.width && candidate.height === previous.height)) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
        candidates.push({ selector, label: candidates.length ? `Parent: ${node.tagName.toLowerCase()}${text ? ` — ${text}` : ""}` : `Exact: ${node.tagName.toLowerCase()}${text ? ` — ${text}` : ""}`, visible: true, x: previous.x, y: previous.y, width: previous.width, height: previous.height });
      }
      node = node.parentElement;
    }
    return { stale: false, candidates };
  }, point);
  if (result?.stale) throw new HttpError(409, "Preview content changed after the screenshot. Refresh the preview before selecting.");
  const candidates = result?.candidates ?? [];
  const selection = candidates[0];
  if (!selection?.visible || !selection.selector || await page.locator(selection.selector).count() !== 1)
    throw new HttpError(422, "A unique visible region could not be selected");
  return { selection, candidates };
}

export async function previewRegion(m: Monitor, cfg: Config, point?: { x: number; y: number }, policy = new EgressPolicy(), session?: { ownerId: string; id?: string; retain?: boolean; captureLayout?: boolean; refresh?: boolean; progress?: (stage: PreviewStage) => void; signal?: AbortSignal; operations?: PreviewOperations; acquireCapacity?: (onWait: () => void) => Promise<ChromiumLease | null> }) {
  let stage: CaptureStage = "target_validation";
  await purgeExpired();
  if (session?.id) {
    const active = sessions.get(session.id);
    if (!active || active.ownerId !== session.ownerId) throw regionPreviewFailure(new HttpError(410, "Preview expired. Create a new preview and try again."), "text_extraction");
    const absoluteDeadline = Math.min(Date.now() + cfg.CAPTURE_TIMEOUT_MS, active.expiresAt);
    const activeRemaining = () => Math.max(1, absoluteDeadline - Date.now());
    try {
      stage = "text_extraction";
      if (session.refresh) {
        session.progress?.("rendering_preparation");
        await boundedPreviewOperation({ operation: () => (session.operations?.snapshot ?? snapshotLayout)(active.page), remaining: activeRemaining, cancel: () => closeSession(active), stage: "screenshot", signal: session.signal });
        session.progress?.("screenshot");
        active.image = await boundedPreviewOperation({ operation: () => (session.operations?.screenshot ?? capturePreviewScreenshot)(active.context, active.page), remaining: activeRemaining, cancel: () => closeSession(active), stage: "screenshot", signal: session.signal });
        pngDimensions(active.image, { width: cfg.MAX_CAPTURE_WIDTH, height: cfg.MAX_CAPTURE_HEIGHT, pixels: cfg.MAX_CAPTURE_PIXELS });
      }
      const picked = point ? await boundedPreviewOperation({ operation: () => selectionAt(active.page, point), remaining: activeRemaining, cancel: () => closeSession(active), stage: "text_extraction", signal: session.signal }) : null;
      if (picked) checkDimensions({ width: Math.ceil(picked.selection.width), height: Math.ceil(picked.selection.height) }, { width: cfg.MAX_CAPTURE_WIDTH, height: cfg.MAX_CAPTURE_HEIGHT, pixels: cfg.MAX_CAPTURE_PIXELS });
      return { session_id: active.id, image: active.image.toString("base64"), width: 1280, height: 900, selection: picked?.selection ?? null, candidates: picked?.candidates ?? [], timings: active.timings, reused: true };
    } catch (error) {
      if (session.signal?.aborted || Date.now() >= active.expiresAt) await closeSession(active);
      throw regionPreviewFailure(error, stage);
    }
  }
  if (m.kind !== "browser" || !m.visual_enabled) throw new HttpError(422, "Visual browser capture is required");
  if ((m.browser_steps ?? []).some((step) => step.action === "fill_private")) throw new HttpError(422, "Region preview does not use private values");
  // Admission does not consume the configured browser execution budget.
  let deadline = 0;
  const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw new HttpError(504, "Preview timed out"); return value; };
  let proxy: Awaited<ReturnType<typeof browserProxy>> | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let capacity: ChromiumLease | undefined;
  let reservation: ReturnType<typeof reserveSession> | undefined;
  const cancelBrowser = async () => {
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  };
  const abortBrowser = () => { void cancelBrowser(); };
  const timings: PreviewTimings = {};
  let previewStage: PreviewStage = "target_validation";
  let stageStarted = performance.now();
  const enter = (next: PreviewStage) => { timings[previewStage] = Math.round(performance.now() - stageStarted); previewStage = next; stageStarted = performance.now(); session?.progress?.(next); };
  try {
    if (session?.signal?.aborted) throw new HttpError(499, "Preview request was cancelled");
    session?.signal?.addEventListener("abort", abortBrowser, { once: true });
    session?.progress?.("target_validation");
    await policy.target(m.url);
    const existing = session?.retain ? [...sessions.values()].find((entry) => entry.ownerId === session.ownerId) : undefined;
    if (existing) await closeSession(existing);
    if (session?.acquireCapacity) {
      enter("capacity_wait");
      capacity = await session.acquireCapacity(() => session.progress?.("capacity_wait")) ?? undefined;
      if (session.signal?.aborted) throw new HttpError(499, "Preview request was cancelled");
      if (!capacity) throw new CaptureFailure("browser_launch", "capacity_wait_timeout", "No browser capacity became available in time. Retry shortly.");
    }
    if (session?.signal?.aborted) throw new HttpError(499, "Preview request was cancelled");
    deadline = Date.now() + cfg.CAPTURE_TIMEOUT_MS;
    reservation = reserveSession(session?.ownerId ?? randomUUID(), false);
    enter("proxy_initialization");
    proxy = await browserProxy(policy);
    enter("browser_launch");
    stage = "browser_launch";
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH, proxy: { server: proxy.url, bypass: "<-loopback>" }, timeout: remaining() });
    stage = "browser_context";
    enter("browser_context");
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", serviceWorkers: "block", ignoreHTTPSErrors: false });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    stage = "navigation";
    enter("navigation");
    const response = await page.goto(m.url, { waitUntil: "domcontentloaded", timeout: remaining() });
    if (!response?.ok()) throw new HttpError(422, `HTTP ${response?.status() ?? 0}`);
    enter("dom_ready");
    await page.addStyleTag({ content: "* { animation:none !important; transition:none !important; caret-color:transparent !important; }" });
    stage = "browser_steps";
    enter("browser_steps");
    await runSteps(page, m.browser_steps ?? [], Math.min(deadline, Date.now() + (m.step_budget_ms ?? 20_000)));
    enter("rendering_preparation");
    stage = "font_wait";
    await page.evaluate(async () => {
      await Promise.race([
        Promise.all([document.fonts.ready.catch(() => undefined), Promise.all([...document.images].map((image) => image.complete ? undefined : new Promise<void>((resolve) => { image.addEventListener("load", () => resolve(), { once: true }); image.addEventListener("error", () => resolve(), { once: true }); })))]),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    });
    stage = "screenshot";
    if (session?.captureLayout !== false)
      await boundedPreviewOperation({ operation: () => (session?.operations?.snapshot ?? snapshotLayout)(page), remaining, cancel: cancelBrowser, stage, signal: session?.signal });
    enter("screenshot");
    const image = await boundedPreviewOperation({ operation: () => (session?.operations?.screenshot ?? capturePreviewScreenshot)(context!, page), remaining, cancel: cancelBrowser, stage, signal: session?.signal });
    pngDimensions(image, { width: cfg.MAX_CAPTURE_WIDTH, height: cfg.MAX_CAPTURE_HEIGHT, pixels: cfg.MAX_CAPTURE_PIXELS });
    const picked = point ? await selectionAt(page, point) : null;
    enter("serialization");
    const encoded = image.toString("base64");
    timings.serialization = Math.round(performance.now() - stageStarted);
    session?.progress?.("ready");
    if (!session?.retain) return { image: encoded, width: 1280, height: 900, selection: picked?.selection ?? null, candidates: picked?.candidates ?? [], timings };
    const createdAt = Date.now();
    const active: Session = { id: randomUUID(), ownerId: session.ownerId, createdAt, expiresAt: createdAt + REGION_PREVIEW_MAX_LIFETIME_MS, browser, context, page, proxy, capacity, image, timings };
    active.expiryTimer = setTimeout(() => void closeSession(active), REGION_PREVIEW_MAX_LIFETIME_MS);
    active.expiryTimer.unref();
    sessions.set(active.id, active);
    browser = undefined; context = undefined; proxy = undefined; capacity = undefined;
    return { session_id: active.id, image: encoded, width: 1280, height: 900, selection: picked?.selection ?? null, candidates: picked?.candidates ?? [], timings, reused: false };
  } catch (error) { throw regionPreviewFailure(error, stage); }
  finally {
    session?.signal?.removeEventListener("abort", abortBrowser);
    if (reservation) reservations.delete(reservation.token);
    try { await context?.close(); } catch {}
    try { await browser?.close(); } finally { await proxy?.close(); await capacity?.release().catch(() => {}); }
  }
}
