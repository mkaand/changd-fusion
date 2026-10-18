// Synthetic, network-isolated, serial comparison of the complete capture path.
// Run via .github/workflows/capture-performance.yml; never supply real targets.
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { capture as after } from "../dist/capture.js";
import { EgressPolicy } from "../dist/egress.js";
import { readConfig } from "../dist/config.js";

const { capture: before } = await import(pathToFileURL(process.env.CAPTURE_BASELINE_MODULE));
const output = "/results";
await mkdir(output, { recursive: true });
const memory = () => readFile("/sys/fs/cgroup/memory.current", "utf8").then(Number);
const cpu = async () => Object.fromEntries((await readFile("/sys/fs/cgroup/cpu.stat", "utf8")).trim().split("\n").map(line => {
  const [key, value] = line.split(" "); return [key, Number(value)];
}));
async function processes() {
  const rows = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      if (/^Name:\s+(?:chrome|chromium)/m.test(status)) rows.push({ pid: Number(pid), rss, zombie: /^State:\s+Z/m.test(status) });
    } catch { /* Process can exit between directory and status reads. */ }
  }
  return rows;
}
assert.equal(process.getuid(), 1000);
assert.equal((await readFile("/sys/fs/cgroup/cpu.max", "utf8")).trim(), "50000 100000");
assert.equal((await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim(), "805306368");
assert.equal((await readFile("/sys/fs/cgroup/pids.max", "utf8")).trim(), "256");

const pending = new Set();
const fixture = http.createServer((req, res) => {
  if (req.url === "/timeout") return;
  if (req.url === "/redirect") { res.writeHead(302, { Location: "/visible" }); res.end(); return; }
  if (req.url.startsWith("/deferred.js")) {
    const delay = req.url.includes("error") ? 3000 : 1200;
    const timer = setTimeout(() => {
      pending.delete(timer);
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end('document.querySelector("#target").textContent="Deferred synthetic ready";document.querySelector("#target").style.background="#267850";');
    }, delay);
    pending.add(timer); return;
  }
  if (req.url === "/slow.svg") {
    const timer = setTimeout(() => {
      pending.delete(timer); res.setHeader("Content-Type", "image/svg+xml");
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>');
    }, 1800);
    pending.add(timer); return;
  }
  const name = req.url.slice(1);
  const error = name === "error_deferred";
  res.writeHead(error ? 503 : 200, { "Content-Type": "text/html" });
  const y = name === "partial" ? 850 : ["offscreen", "nested"].includes(name) ? 1600 : 60;
  const target = `<main id="target" style="top:${y}px">Synthetic target</main>`;
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${name === "challenge" ? "Just a moment" : "Synthetic fixture"}</title>
    <style>html{scroll-behavior:smooth}body{margin:0;font:16px sans-serif}#target{position:absolute;left:40px;width:320px;height:240px;background:#267850}#spacer{height:2400px}.nested{position:relative;overflow:auto;height:500px;width:600px}</style>
    ${["delayed_dcl", "error_deferred"].includes(name) ? `<script defer src="/deferred.js?${error ? "error" : "ok"}"></script>` : ""}</head><body>
    ${name === "nested" ? `<div class="nested">${target}<div id="spacer"></div></div>` : target + '<div id="spacer"></div>'}
    ${name === "slow_resource" ? '<img src="/slow.svg" style="position:absolute;top:2300px" alt="synthetic">' : ""}
    ${name === "steps" ? '<button style="position:absolute;top:320px" onclick="document.querySelector(\'#target\').textContent=\'Applied synthetic step\'">Apply</button>' : ""}
    ${name === "heavy_js" ? '<script>for(let i=0;i<5000;i++){const n=document.createElement("span");n.textContent="synthetic";document.getElementById("spacer").append(n)};document.querySelector("#target").textContent="JS synthetic ready";</script>' : ""}
    ${name === "offscreen" ? '<script>new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))document.querySelector("#target").style.background="#267850"}).observe(document.querySelector("#target"));document.querySelector("#target").style.background="#a02020";</script>' : ""}
    </body></html>`);
});
await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
const port = fixture.address().port;
const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], ip => ip === "127.0.0.1", new Set([port]));
const cfg = readConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/unused", JWT_SECRET: randomBytes(32).toString("hex"), CHANNEL_KEY: randomBytes(32).toString("hex"), CAPTURE_TIMEOUT_MS: "15000" });
const scenarios = ["static", "heavy_js", "slow_resource", "delayed_dcl", "visible", "partial", "offscreen", "nested", "steps", "redirect", "challenge", "error_deferred", "timeout"];
const samples = [];
const images = new Map();
const quantile = (values, p) => { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]; };
let failure = false;
try {
  for (const scenario of scenarios) {
    const expectedFailure = ["challenge", "error_deferred", "timeout"].includes(scenario);
    // One unmeasured warm-up followed by seven measured cold-browser captures.
    // The pipeline launches a new browser for every monitor; no pooling is used.
    for (let run = -1; run < 7; run++) for (const engine of run % 2 === 0 ? ["after", "before"] : ["before", "after"]) {
      const capture = engine === "before" ? before : after;
      const startCPU = await cpu();
      let peakMemory = await memory(), peakRSS = 0;
      const observer = setInterval(() => {
        void Promise.all([memory(), processes()]).then(([bytes, rows]) => {
          peakMemory = Math.max(peakMemory, bytes);
          peakRSS = Math.max(peakRSS, rows.reduce((sum, row) => sum + row.rss, 0));
        }).catch(() => {});
      }, 50);
      const started = performance.now();
      let timings = {}, code = null, png, valid = false;
      try {
        const result = await capture({
          url: `http://fixture.test:${port}/${scenario}`, kind: "browser", text_enabled: true, visual_enabled: true,
          selector: "#target", selector_type: "css", ignore_selectors: [], mask_selectors: [], ignore_text: [],
          normalize_whitespace: true, ignore_case: false, capture_mode: scenario === "static" ? "viewport" : "element",
          capture_selector: scenario === "nested" ? "//main" : "#target", capture_selector_type: scenario === "nested" ? "xpath" : "css",
          browser_steps: scenario === "steps" ? [{ action: "click", selector: "button" }] : [],
        }, scenario === "timeout" ? { ...cfg, CAPTURE_TIMEOUT_MS: 2500 } : cfg, policy);
        timings = result.timings;
        png = PNG.sync.read(result.screenshot);
        assert.equal(png.width, scenario === "static" ? 1280 : 320);
        assert.equal(png.height, scenario === "static" ? 900 : 240);
        const offset = ((scenario === "static" ? 200 : 200) * png.width + (scenario === "static" ? 200 : 200)) * 4;
        assert.deepEqual([...png.data.subarray(offset, offset + 3)], [38, 120, 80], "target/lazy content must render");
        assert.equal(result.text, scenario === "steps" ? "Applied synthetic step" : scenario === "delayed_dcl" ? "Deferred synthetic ready" : scenario === "heavy_js" ? "JS synthetic ready" : "Synthetic target");
        if (expectedFailure) throw Error("invalid error document accepted");
        valid = true;
        if (run === 0) {
          images.set(`${engine}/${scenario}`, png);
          await writeFile(`${output}/${engine}-${scenario}.png`, result.screenshot);
        }
      } catch (error) {
        timings = error.timings ?? timings;
        code = error.code ?? error.state ?? "assertion_failure";
        const expectedCode = scenario === "challenge" ? "challenge_detected" : scenario === "error_deferred" ? "capture_failed" : "timeout";
        if (!expectedFailure || code !== expectedCode) failure = true;
      } finally { clearInterval(observer); }
      const elapsed = performance.now() - started;
      const endCPU = await cpu();
      // Capture has completed both bounded cleanup calls; allow the init process
      // a brief, bounded chance to reap exited grandchildren before observation.
      let remaining = await processes();
      for (let attempt = 0; remaining.length && attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50)); remaining = await processes();
      }
      if (remaining.length) failure = true;
      const row = { engine, scenario, run, measured: run >= 0, browser: "cold", wall_ms: Math.round(elapsed), timings,
        code, valid, expected_failure: expectedFailure, width: png?.width ?? null, height: png?.height ?? null,
        peak_cgroup_bytes: peakMemory, peak_browser_rss_bytes: peakRSS,
        cpu_usec: endCPU.usage_usec - startCPU.usage_usec, throttled_usec: endCPU.throttled_usec - startCPU.throttled_usec,
        nr_throttled: endCPU.nr_throttled - startCPU.nr_throttled, remaining_processes: remaining.length };
      samples.push(row);
      console.log(JSON.stringify({ engine, scenario, run, wall_ms: row.wall_ms, valid, code, remaining: remaining.length }));
    }
  }
} finally {
  for (const timer of pending) clearTimeout(timer);
  await new Promise(resolve => { fixture.close(resolve); fixture.closeAllConnections(); });
}
const comparisons = scenarios.filter(s => images.has(`before/${s}`) && images.has(`after/${s}`)).map(scenario => {
  const a = images.get(`before/${scenario}`), b = images.get(`after/${scenario}`);
  return { scenario, different_pixels: pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }), pixels: a.width * a.height };
});
if (comparisons.some(row => row.different_pixels !== 0)) failure = true;
const summary = scenarios.flatMap(scenario => ["before", "after"].map(engine => {
  const rows = samples.filter(row => row.scenario === scenario && row.engine === engine && row.measured);
  const stage = name => ({ p50: quantile(rows.map(row => row.timings[name] ?? 0), .5), p95: quantile(rows.map(row => row.timings[name] ?? 0), .95) });
  return { scenario, engine, count: rows.length, valid: rows.filter(row => row.valid).length, failures: rows.filter(row => row.code).length,
    wall_p50_ms: quantile(rows.map(row => row.wall_ms), .5), wall_p95_ms: quantile(rows.map(row => row.wall_ms), .95),
    navigation: stage("navigation"), scroll: stage("scroll_into_view"), attention: stage("attention_detection"), screenshot: stage("screenshot_rasterization"),
    cpu_p50_usec: quantile(rows.map(row => row.cpu_usec), .5), throttled_p50_usec: quantile(rows.map(row => row.throttled_usec), .5),
    peak_cgroup_bytes: Math.max(...rows.map(row => row.peak_cgroup_bytes)), peak_browser_rss_bytes: Math.max(...rows.map(row => row.peak_browser_rss_bytes)) };
}));
const environment = { cpu: "0.5", memory_mib: 768, pids: 256, concurrency: 1, viewport: [1280, 900], scale: 1,
  chromium: execFileSync(chromium.executablePath(), ["--version"], { encoding: "utf8", timeout: 5000 }).trim(),
  optimized: process.env.CAPTURE_OPTIMIZED_SHA ?? "unspecified",
  node: process.version, baseline: "21990d7784e9f9f94976c20fdf32bfc63bbe7a45", cpu_model: (await readFile("/proc/cpuinfo", "utf8")).match(/^model name\s*:\s*(.+)/m)?.[1],
  playwright: JSON.parse(await readFile(new URL("../node_modules/playwright/package.json", import.meta.url), "utf8")).version,
  methodology: "one excluded warm-up; seven fresh-browser samples; alternating order; complete pipeline including cleanup; no external network; 50ms memory/RSS samples; cgroup CPU accounting; not VPS measurements" };
await writeFile(`${output}/results.json`, JSON.stringify({ environment, samples, summary, comparisons, passed: !failure }, null, 2));
const markdown = ["# Chromium capture comparison", "", `Baseline: ${environment.baseline}`, "", environment.methodology, "",
  "| Scenario | Revision | p50 ms | p95 ms | Navigation p50 | Scroll p50 | CPU p50 ms | Peak cgroup MiB | Valid / 7 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ...summary.map(row => `| ${row.scenario} | ${row.engine} | ${row.wall_p50_ms} | ${row.wall_p95_ms} | ${row.navigation.p50} | ${row.scroll.p50} | ${Math.round(row.cpu_p50_usec / 1000)} | ${Math.round(row.peak_cgroup_bytes / 1048576)} | ${row.valid}/7 |`), "",
  "Challenge/error/timeout fixtures are expected failures, never valid captures. Stage and cleanup data are in results.json.", "", "## Screenshot comparison", ...comparisons.map(row => `- ${row.scenario}: ${row.different_pixels} differing pixels / ${row.pixels}`), "",
  `Result: ${failure ? "FAIL" : "PASS"}`].join("\n");
await writeFile(`${output}/summary.md`, markdown);
console.log(markdown);
const aggregate = ["before", "after"].map(engine => {
  const rows = samples.filter(row => row.engine === engine && row.measured && !row.expected_failure);
  return { engine, samples: rows.length, valid: rows.filter(row => row.valid).length,
    p50_ms: quantile(rows.map(row => row.wall_ms), .5), p95_ms: quantile(rows.map(row => row.wall_ms), .95),
    cpu_p50_ms: Math.round(quantile(rows.map(row => row.cpu_usec), .5) / 1000),
    throttled_p50_ms: Math.round(quantile(rows.map(row => row.throttled_usec), .5) / 1000),
    peak_cgroup_mib: Math.round(Math.max(...rows.map(row => row.peak_cgroup_bytes)) / 1048576),
    peak_browser_rss_mib: Math.round(Math.max(...rows.map(row => row.peak_browser_rss_bytes)) / 1048576),
    remaining_processes: Math.max(...rows.map(row => row.remaining_processes)) };
});
console.log("CAPTURE_RESULT_SUMMARY " + JSON.stringify({ environment, summary, aggregate, comparisons, passed: !failure }));
if (failure) process.exitCode = 1;
