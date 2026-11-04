import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readConfig } from "../src/config.js";
import { capture } from "../src/capture.js";
import { closeRegionPreviewSessions, previewRegion } from "../src/region-picker.js";
import { EgressPolicy } from "../src/egress.js";

test("real Chromium applies disable_javascript consistently to capture and preview", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/mutation.js") return void res.end("document.querySelector('#static').textContent='scripted';document.body.insertAdjacentHTML('beforeend','<p id=generated>generated</p>')");
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><main id=static>static</main><script>document.querySelector('#static').textContent='inline';</script><script src=/mutation.js></script><a href=/next id=link>next</a>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await closeRegionPreviewSessions(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const port = (server.address() as AddressInfo).port, root = await mkdtemp(path.join(os.tmpdir(), "fusion-js-"));
  t.after(() => rm(root, { recursive:true, force:true }));
  const cfg = readConfig({ NODE_ENV:"test", DATABASE_URL:"postgres://unused", JWT_SECRET:randomBytes(32).toString("hex"), CHANNEL_KEY:randomBytes(32).toString("hex"), DATA_DIR:root, PLAYWRIGHT_EXECUTABLE_PATH:process.env.PLAYWRIGHT_EXECUTABLE_PATH, LOG_LEVEL:"silent" });
  const policy = new EgressPolicy(async () => [{ address:"127.0.0.1", family:4 }], () => true, new Set([port]));
  const base:any = { id:randomUUID(), url:`http://fixture.test:${port}/`, kind:"browser", text_enabled:true, visual_enabled:true, selector:"body", selector_type:"css", capture_mode:"viewport", browser_steps:[], ignore_selectors:[], ignore_text:[], mask_selectors:[], normalize_whitespace:true, ignore_case:false };
  const enabled = await capture({ ...base, disable_javascript:false }, cfg, policy);
  const disabled = await capture({ ...base, disable_javascript:true }, cfg, policy);
  assert.match(enabled.text!, /scripted/); assert.match(enabled.text!, /generated/);
  assert.match(disabled.text!, /static/); assert.doesNotMatch(disabled.text!, /scripted|generated/);
  const preview = await previewRegion({ ...base, disable_javascript:true }, cfg, undefined, policy, { ownerId:"js-fixture", retain:false });
  assert.equal(preview.width, 1280); assert.ok(Buffer.from(preview.image, "base64").length > 100);
});
