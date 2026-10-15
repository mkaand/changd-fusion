import {
  chromium,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import type { Config } from "./config.js";

export type CaptureEngine = Config["CAPTURE_ENGINE"];

export async function launchCaptureBrowser(
  cfg: Config,
  proxyUrl: string,
  timeout: number,
): Promise<Browser> {
  const common = {
    headless: true,
    timeout,
    proxy: { server: proxyUrl, bypass: "<-loopback>" },
  };
  if (cfg.CAPTURE_ENGINE === "webkit") {
    return webkit.launch({
      ...common,
      ...(cfg.WEBKIT_EXECUTABLE_PATH
        ? { executablePath: cfg.WEBKIT_EXECUTABLE_PATH }
        : {}),
    });
  }
  return chromium.launch({
    ...common,
    chromiumSandbox: true,
    executablePath: cfg.PLAYWRIGHT_EXECUTABLE_PATH,
  });
}

export async function captureViewportPng(
  engine: CaptureEngine,
  context: BrowserContext,
  page: Page,
  timeout: number,
) {
  if (engine === "webkit") {
    return page.screenshot({
      type: "png",
      animations: "disabled",
      fullPage: false,
      timeout,
    });
  }
  const cdp = await context.newCDPSession(page);
  try {
    const captured = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return Buffer.from(captured.data, "base64");
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function captureClipPng(
  engine: CaptureEngine,
  context: BrowserContext,
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  timeout: number,
) {
  if (engine === "webkit") {
    return page.screenshot({
      type: "png",
      animations: "disabled",
      clip,
      timeout,
    });
  }
  const cdp = await context.newCDPSession(page);
  try {
    const captured = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { ...clip, scale: 1 },
    });
    return Buffer.from(captured.data, "base64");
  } finally {
    await cdp.detach().catch(() => {});
  }
}
