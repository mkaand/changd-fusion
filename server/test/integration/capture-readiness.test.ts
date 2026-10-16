import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { PNG } from "pngjs";
import { capture, type Monitor } from "../../src/capture.js";
import { EgressPolicy } from "../../src/egress.js";
import { readConfig } from "../../src/config.js";
import { closeServer, listenServer } from "../helpers/server.js";

test("capture retains deferred JS readiness and scrolls CSS/XPath regions without pre-scroll actionability waits", async (t) => {
  const fixture = http.createServer((req, res) => {
    if (req.url === "/never.js") return;
    if (req.url === "/ready.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end('document.querySelector("main").textContent="Deferred JS finished";'); return;
    }
    if (req.url === "/error") res.statusCode = 503;
    res.setHeader("Content-Type", "text/html");
    const offset = req.url === "/partial" ? 850 : req.url === "/nested" ? 1600 : 60;
    res.end(`<style>html{scroll-behavior:smooth}body{margin:0}main{position:absolute;left:40px;top:${offset}px;width:320px;height:240px;background:#267850}section{height:500px;overflow:auto;position:relative}</style>
      <script defer src="${req.url === "/error" ? "/never.js" : "/ready.js"}"></script>
      ${req.url === "/nested" ? "<section>" : ""}<main>Not ready</main><footer style="height:2400px"></footer>${req.url === "/nested" ? "</section>" : ""}
      <script>addEventListener("scroll",()=>{if(location.pathname==="/visible")document.querySelector("main").style.background="red"},{capture:true});</script>`);
  });
  t.after(() => closeServer(fixture));
  await listenServer(fixture);
  const port = (fixture.address() as AddressInfo).port;
  const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], ip => ip === "127.0.0.1", new Set([port]));
  const cfg = readConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/unused", JWT_SECRET: randomBytes(32).toString("hex"), CHANNEL_KEY: randomBytes(32).toString("hex"), CAPTURE_TIMEOUT_MS: "10000", PLAYWRIGHT_EXECUTABLE_PATH: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  const base = { kind: "browser", text_enabled: true, visual_enabled: true, selector: "main", selector_type: "css", capture_mode: "element", capture_selector: "main", capture_selector_type: "css", browser_steps: [], mask_selectors: [], ignore_selectors: [], ignore_text: [], ignore_case: false, normalize_whitespace: true } as unknown as Monitor;
  for (const route of ["visible", "partial", "nested"]) {
    const result = await capture({ ...base, url: `http://fixture.test:${port}/${route}`, ...(route === "nested" ? { capture_selector: "//main", capture_selector_type: "xpath" } : {}) }, cfg, policy);
    assert.equal(result.text, "Deferred JS finished");
    const image = PNG.sync.read(result.screenshot!);
    assert.deepEqual([image.width, image.height], [320, 240]);
    const pixel = (200 * image.width + 200) * 4;
    assert.deepEqual([...image.data.subarray(pixel, pixel + 3)], [38, 120, 80], "visible target is not scrolled; offscreen target is captured completely");
  }
  await assert.rejects(capture({ ...base, url: `http://fixture.test:${port}/error` }, cfg, policy),
    (error: any) => error.code === "capture_failed" && /unsuccessful HTTP/.test(error.message));
});
