import type { BrowserContext, Page, Response } from "playwright";
import type { BrowserStep } from "./browser-steps.js";

export type BrowserViewport = { width: number; height: number };

export function browserViewport(mobile: boolean): BrowserViewport {
  return mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
}

const TRACKER_HOSTS = [
  "doubleclick.net",
  "google-analytics.com",
  "googletagmanager.com",
  "facebook.net",
  "hotjar.com",
  "segment.io",
  "mixpanel.com",
  "amazon-adsystem.com",
  "googlesyndication.com",
];

export function isTrackerHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return TRACKER_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export async function installBrowserRouting(
  context: BrowserContext,
  targetUrl: string,
  options: { privateWorkflow: boolean; blockTrackers: boolean },
) {
  if (options.privateWorkflow || options.blockTrackers) {
    const targetOrigin = new URL(targetUrl).origin;
    await context.route("**/*", async (route) => {
      try {
        const requested = new URL(route.request().url());
        if (
          (options.privateWorkflow && requested.origin !== targetOrigin) ||
          (options.blockTrackers && isTrackerHostname(requested.hostname))
        ) {
          await route.abort("blockedbyclient");
          return;
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
].join(",");
const REJECT_NAMES = /^(?:reject(?: all)?|decline(?: all)?|deny(?: all)?|only necessary|necessary only|continue without accepting|dismiss)$/i;

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
      const button = root.getByRole("button", { name: REJECT_NAMES }).first();
      if (await button.count()) {
        await button.click({ timeout });
        return true;
      }
    } catch {
      // Automatic dismissal is best-effort. A manual step remains available
      // when a site's consent UI does not meet this deliberately narrow policy.
    }
  }
  return false;
}
