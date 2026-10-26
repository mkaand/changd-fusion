import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { runSteps, StepFailure } from "../../src/browser-steps.js";

test("Chromium click diagnostics and shared deadlines remain bounded", async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, chromiumSandbox: true });
  try {
    for (const [selector, category] of [["#missing", "selector_missing"], ["#hidden", "element_not_actionable"]] as const) {
      const page = await browser.newPage();
      try {
        await page.setContent('<button id="hidden" style="display:none">Synthetic fixture</button>');
        await assert.rejects(runSteps(page, [{ action: "click", selector, timeout_ms: 1000 }], Date.now() + 5000), (e: any) => e instanceof StepFailure && e.step === 1 && e.action === "click" && e.category === category && !e.message.includes(selector));
      } finally { await page.close(); }
    }
    for (const capture of [false, true]) {
      const page = await browser.newPage();
      try {
        await assert.rejects(runSteps(page, [{ action: "wait_selector", selector: "#missing", timeout_ms: 60000, continue_on_error: true }], Date.now() + (capture ? 60000 : 150), {}, capture ? Date.now() + 150 : Infinity), (e: any) => e instanceof StepFailure && e.category === (capture ? "capture_deadline" : "workflow_deadline"));
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test("mobile Preview header and editor spacing stay bounded with a simulated iOS safe area", async () => {
  const css = await readFile(new URL("../../../frontend/src/style.css", import.meta.url), "utf8");
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, chromiumSandbox: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      // Use the production CSS with deterministic inset values; native Safari
      // still needs acceptance on an actual iPhone.
      await page.setContent(`<style>body{margin:0}*{box-sizing:border-box}${css.replaceAll("env(safe-area-inset-top)", "44px")}</style><header class="header">Application</header><main class="content"><section class="mobile-region-picker-page"><div class="mobile-editor-header"><button class="ant-btn">← Back</button><h4 class="ant-typography">Add browser step</h4></div></section><section class="browser-steps-editor"><button class="ant-btn">Add step from Preview</button><button class="ant-btn">Add browser step</button></section><div id="capture">Screenshot capture mode</div></main>`);
      const box = (selector: string) => page.locator(selector).boundingBox();
      const app = (await box(".header"))!, header = (await box(".mobile-editor-header"))!;
      assert.ok(header.y >= app.y + app.height, "preview header does not overlap application header");
      const buttons = await page.locator(".browser-steps-editor button").all();
      const first = (await buttons[0].boundingBox())!, second = (await buttons[1].boundingBox())!;
      assert.equal(second.y - first.y - first.height, 12);
      assert.equal((await box("#capture"))!.y - second.y - second.height, 24);
      assert.ok(await page.locator(".mobile-editor-header button").isVisible());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    } finally { await page.close(); }
  } finally { await browser.close(); }
});
