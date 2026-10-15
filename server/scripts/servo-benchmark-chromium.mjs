import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const [url, outputPath, stagePath, fullPageValue, settleValue, timeoutValue] = process.argv.slice(2);
const fullPage = fullPageValue === "true";
const settleMs = Number(settleValue);
const timeoutMs = Number(timeoutValue);
const stages = {};
const measure = async (name, operation) => {
  const started = performance.now();
  try { return await operation(); }
  finally { stages[name] = performance.now() - started; }
};

let browser;
try {
  browser = await measure("startupMs", () => chromium.launch({
    headless: true,
    chromiumSandbox: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "/usr/bin/chromium",
  }));
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    ignoreHTTPSErrors: false,
  });
  const page = await context.newPage();
  await measure("navigationMs", () => page.goto(url, { waitUntil: "load", timeout: timeoutMs }));
  await measure("settleMs", () => page.waitForTimeout(settleMs));
  await measure("screenshotMs", () => page.screenshot({
    path: outputPath,
    type: "png",
    fullPage,
    animations: "disabled",
    timeout: timeoutMs,
  }));
  await context.close();
  await writeFile(stagePath, JSON.stringify(stages));
} finally {
  await browser?.close().catch(() => {});
}
