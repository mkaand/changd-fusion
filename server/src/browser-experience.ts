import type { BrowserContext, Page, Response } from "playwright";
import type { BrowserStep } from "./browser-steps.js";
import { adblockEngine, shouldBlockRequest } from "./adblock.js";

export type BrowserViewport = { width: number; height: number };

export function browserViewport(mobile: boolean): BrowserViewport {
  return mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
}

export async function installBrowserRouting(
  context: BrowserContext,
  targetUrl: string,
  options: { privateWorkflow: boolean; blockTrackers: boolean },
) {
  // Load one verified, local snapshot before navigation. A missing/corrupt
  // snapshot fails the capture instead of silently running without blocking.
  const engine = options.blockTrackers ? await adblockEngine() : undefined;
  if (options.privateWorkflow || options.blockTrackers) {
    const targetOrigin = new URL(targetUrl).origin;
    await context.route("**/*", async (route) => {
      try {
        const requested = new URL(route.request().url());
        // Private workflow isolation has priority over filter exceptions.
        if (options.privateWorkflow && requested.origin !== targetOrigin) {
          await route.abort("blockedbyclient");
          return;
        }
        if (engine) {
          const request = route.request();
          let sourceUrl = targetUrl;
          let type = request.resourceType();
          try {
            const frame = request.frame();
            const sourceFrame = request.isNavigationRequest() ? frame.parentFrame() : frame;
            const candidate = sourceFrame?.url();
            if (candidate?.startsWith("http://") || candidate?.startsWith("https://")) sourceUrl = candidate;
            if (request.isNavigationRequest()) type = frame.parentFrame() ? "sub_frame" : "main_frame";
          } catch { /* Service workers are blocked by the browser context. */ }
          if (shouldBlockRequest(engine, requested.href, sourceUrl, type)) {
            await route.abort("blockedbyclient");
            return;
          }
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
  }
  // WebSocket traffic is not supported by the pinned-IP HTTP proxy contract.
  // It must fail closed rather than acquire an independent network path.
  await context.routeWebSocket("**/*", (socket) => socket.close());
}

export function observeMainFrameStatus(page: Page) {
  let status: number | undefined;
  const record = (response: Response) => {
    if (response.frame() === page.mainFrame() && response.request().isNavigationRequest())
      status = response.status();
  };
  page.on("response", record);
  return {
    setInitial(value: number) { status = value; },
    value() { return status; },
    dispose() { page.off("response", record); },
  };
}

const CONSENT_ROOTS = [
  '[role="dialog"][aria-modal="true"][aria-label*="cookie" i]',
  '[role="dialog"][aria-modal="true"][aria-label*="consent" i]',
  '[aria-label*="cookie" i]',
  '[aria-label*="consent" i]',
  '[id*="cookie" i]',
  '[id*="consent" i]',
  '[class*="cookie" i]',
  '[class*="consent" i]',
  '#ccc-notify',
  '#ccc',
  '[id*="cookiecontrol" i]',
  '[class*="ccc-notify" i]',
].join(",");
// "Accept" is safe only when the control explicitly limits consent to
// necessary cookies; neighbouring "Accept all" controls never match.
const REJECT_NAMES = /^(?:reject(?: all| optional cookies?)?|decline(?: all)?|deny(?: all)?|(?:i do not|do not|don't) accept|(?:accept |use )?(?:only )?(?:strictly )?necessary cookies?|necessary only|continue without accepting|dismiss)$/i;
const CONSENT_ACTIONS = 'button, [role="button"], input[type="button"], input[type="submit"]';

function consentActionName(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function hasManualCookieStep(steps: BrowserStep[] | undefined) {
  return Boolean(steps?.some((step) => step.action === "dismiss_cookie"));
}

export async function dismissCookieConsent(
  page: Page,
  deadline: number,
  steps: BrowserStep[] | undefined,
): Promise<boolean> {
  if (hasManualCookieStep(steps)) return false;
  const timeout = Math.min(1500, Math.max(1, deadline - Date.now()));
  for (const root of await page.locator(CONSENT_ROOTS).all()) {
    try {
      if (!(await root.isVisible({ timeout: Math.min(250, timeout) }))) continue;
      const actions = root.locator(CONSENT_ACTIONS);
      const count = Math.min(await actions.count(), 12);
      for (let index = 0; index < count; index++) {
        const action = actions.nth(index);
        if (!(await action.isVisible({ timeout: Math.min(250, timeout) }))) continue;
        const name = consentActionName(
          await action.getAttribute("aria-label")
          ?? await action.getAttribute("value")
          ?? await action.textContent(),
        );
        if (!REJECT_NAMES.test(name)) continue;
        await action.click({ timeout });
        return true;
      }
    } catch {
      // Automatic dismissal is best-effort. A manual step remains available
      // when a site's consent UI does not meet this deliberately narrow policy.
    }
  }
  return false;
}
