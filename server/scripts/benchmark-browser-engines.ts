import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { capture, type Monitor } from "../src/capture.js";
import { readConfig } from "../src/config.js";
import { EgressPolicy } from "../src/egress.js";

type ProcessSample = { cpuTicks: number; rssKb: number; pids: number[] };

async function descendants(root: number): Promise<ProcessSample> {
  const entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  const rows: Array<{ pid: number; ppid: number; ticks: number; rssPages: number }> = [];
  await Promise.all(entries.map(async (entry) => {
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      rows.push({ pid: Number(entry), ppid: Number(fields[1]), ticks: Number(fields[11]) + Number(fields[12]), rssPages: Number(fields[21]) });
    } catch {}
  }));
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; }
  }
  const processes = rows.filter((row) => row.pid !== root && selected.has(row.pid));
  return {
    cpuTicks: processes.reduce((total, row) => total + row.ticks, 0),
    rssKb: processes.reduce((total, row) => total + row.rssPages * 4, 0),
    pids: processes.map((row) => row.pid).sort((a, b) => a - b),
  };
}

async function measured<T>(operation: () => Promise<T>) {
  let peakRssKb = 0, peakCpuTicks = 0, sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const current = await descendants(process.pid);
      peakRssKb = Math.max(peakRssKb, current.rssKb);
      peakCpuTicks = Math.max(peakCpuTicks, current.cpuTicks);
    } finally { sampling = false; }
  };
  const timer = setInterval(() => void sample(), 20);
  const started = performance.now();
  try {
    const value = await operation();
    await sample();
    return { value, durationMs: performance.now() - started, peakRssMb: peakRssKb / 1024, childCpuMs: peakCpuTicks * 10 };
  } finally { clearInterval(timer); }
}

const percentile = (values: number[], ratio: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * ratio) - 1)];
const stageTotal = (timings: Record<string, number> | undefined, stages: string[]) =>
  stages.reduce((total, stage) => total + (timings?.[stage] ?? 0), 0);
const metric = (samples: any[], key: string) => ({
  median: percentile(samples.map((sample) => sample[key]), 0.5),
  p95: percentile(samples.map((sample) => sample[key]), 0.95),
});

const server = createServer((req, res) => {
  if (req.url === "/asset.png") {
    const png = new PNG({ width: 20, height: 20 });
    png.data.fill(180);
    res.setHeader("Content-Type", "image/png");
    res.end(PNG.sync.write(png));
    return;
  }
  if (req.url === "/slow") return;
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><style>body{margin:0;font-family:sans-serif}.region{width:360px;height:220px;background:#1677ff;color:#fff}.masked{width:80px;height:40px;background:#f00}.tall{height:1800px}</style><main class="region"><button id="step" onclick="document.querySelector('#state').textContent='ready'">Run</button><span id="state">idle</span><img src="/asset.png"></main><div class="masked"></div><div class="tall"></div><script>document.documentElement.dataset.rendered='yes'</script>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const root = await mkdtemp(path.join(os.tmpdir(), "fusion-browser-benchmark-"));
const policy = new EgressPolicy(async () => [{ address: "127.0.0.1", family: 4 }], (ip) => ip === "127.0.0.1", new Set([port]));
const base = {
  id: "00000000-0000-4000-8000-000000000001", user_id: "fixture", name: "Engine benchmark", url: `http://fixture.test:${port}/`, kind: "browser",
  text_enabled: true, text_source: "direct", extraction_mode: "full_text", visual_enabled: true, selector: ".region", selector_type: "css",
  ignore_selectors: [], mask_selectors: [], ignore_text: [], normalize_whitespace: true, ignore_case: false,
  capture_mode: "viewport", capture_selector: ".region", capture_selector_type: "css", browser_steps: [], visual_threshold: "0.35", pixel_threshold: "0.1",
  interval_seconds: 300, baseline_id: null, latest_capture_id: null, failure_count: 0,
} satisfies Monitor;
const cases: Array<{ name: string; monitor: Partial<Monitor> }> = [
  { name: "viewport", monitor: { capture_mode: "viewport" } },
  { name: "full_page", monitor: { capture_mode: "full_page" } },
  { name: "element", monitor: { capture_mode: "element", capture_selector: ".region" } },
  { name: "mask", monitor: { capture_mode: "viewport", mask_selectors: [".masked"] } },
  { name: "browser_step", monitor: { capture_mode: "viewport", browser_steps: [{ action: "click", selector: "#step", selector_type: "css", timeout_ms: 5000, continue_on_error: false }] } },
];
const rounds = 3;
const output: Record<string, any> = {
  generatedAt: new Date().toISOString(),
  cases: cases.map(({ name }) => name),
  rounds,
  samplesPerEngine: cases.length * rounds,
  browserReuse: false,
  cacheModel: "first_round_cold_then_host_cache_warm_repeats; every capture launches a fresh browser",
};
const screenshots: Record<string, Buffer> = {};
try {
  for (const engine of ["chromium", "webkit"] as const) {
    const cfg = readConfig({
      NODE_ENV: "test", DATABASE_URL: "postgresql://localhost/benchmark", JWT_SECRET: "x".repeat(32), CHANNEL_KEY: "0".repeat(64),
      DATA_DIR: root, CAPTURE_ENGINE: engine, PLAYWRIGHT_EXECUTABLE_PATH: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      WEBKIT_EXECUTABLE_PATH: process.env.WEBKIT_EXECUTABLE_PATH, CAPTURE_TIMEOUT_MS: "15000", LOG_LEVEL: "silent",
    });
    const samples: any[] = [];
    for (let round = 0; round < rounds; round++) {
      for (const [index, benchmarkCase] of cases.entries()) {
        try {
          const result = await measured(() => capture({ ...base, ...benchmarkCase.monitor }, cfg, policy));
          if (round === 0 && index === 0) screenshots[engine] = result.value.screenshot!;
          const timings = result.value.timings as Record<string, number> | undefined;
          samples.push({
            case: benchmarkCase.name,
            round,
            cache: round === 0 ? "cold" : "warm",
            durationMs: result.durationMs,
            startupMs: stageTotal(timings, ["proxy_initialization", "browser_launch", "browser_context"]),
            navigationMs: timings?.navigation ?? 0,
            screenshotMs: stageTotal(timings, ["screenshot", "selector_lookup", "visibility_validation", "scroll_into_view", "element_stability", "screenshot_rasterization", "image_validation"]),
            peakRssMb: result.peakRssMb,
            childCpuMs: result.childCpuMs,
            success: true,
            pngBytes: result.value.screenshot?.length ?? 0,
            timings,
          });
        } catch (error) {
          samples.push({ case: benchmarkCase.name, round, cache: round === 0 ? "cold" : "warm", success: false, failure: error instanceof Error ? error.name : "unknown" });
        }
      }
    }
    const successful = samples.filter((sample) => sample.success);
    const cold = successful.filter((sample) => sample.cache === "cold");
    const warm = successful.filter((sample) => sample.cache === "warm");
    const beforeTimeout = await descendants(process.pid);
    const timeoutStarted = performance.now();
    let timeoutFailure = "unexpected_success";
    try {
      await capture({ ...base, url: `http://fixture.test:${port}/slow` }, { ...cfg, CAPTURE_TIMEOUT_MS: 2000 }, policy);
    } catch (error: any) {
      timeoutFailure = typeof error?.code === "string" ? error.code : error instanceof Error ? error.name : "unknown";
    }
    const timeoutDurationMs = performance.now() - timeoutStarted;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const afterTimeout = await descendants(process.pid);
    const previousPids = new Set(beforeTimeout.pids);
    const remainingNewPids = afterTimeout.pids.filter((pid) => !previousPids.has(pid));
    output[engine] = {
      medianMs: percentile(successful.map((sample) => sample.durationMs), 0.5),
      p95Ms: percentile(successful.map((sample) => sample.durationMs), 0.95),
      cold: metric(cold, "durationMs"),
      warm: metric(warm, "durationMs"),
      startup: metric(successful, "startupMs"),
      navigation: metric(successful, "navigationMs"),
      screenshot: metric(successful, "screenshotMs"),
      peakRssMb: Math.max(0, ...successful.map((sample) => sample.peakRssMb)),
      childCpuMs: Math.max(0, ...successful.map((sample) => sample.childCpuMs)),
      successRate: successful.length / samples.length,
      timeout: { durationMs: timeoutDurationMs, failure: timeoutFailure, remainingNewPids },
      samples,
    };
  }
  const chromium = PNG.sync.read(screenshots.chromium);
  const webkit = PNG.sync.read(screenshots.webkit);
  output.rendering = chromium.width === webkit.width && chromium.height === webkit.height
    ? { width: chromium.width, height: chromium.height, differentPixels: pixelmatch(chromium.data, webkit.data, null, chromium.width, chromium.height), totalPixels: chromium.width * chromium.height }
    : { chromium: { width: chromium.width, height: chromium.height }, webkit: { width: webkit.width, height: webkit.height }, dimensionsDiffer: true };
  const serialized = JSON.stringify(output, null, 2);
  if (process.env.WEBKIT_BENCHMARK_PATH) await writeFile(process.env.WEBKIT_BENCHMARK_PATH, serialized + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const format = (value: number) => Number.isFinite(value) ? value.toFixed(1) : "n/a";
    const rendering = output.rendering.dimensionsDiffer
      ? `Dimensions differ: Chromium ${output.rendering.chromium.width}x${output.rendering.chromium.height}, WebKit ${output.rendering.webkit.width}x${output.rendering.webkit.height}`
      : `${output.rendering.differentPixels}/${output.rendering.totalPixels} pixels differ at ${output.rendering.width}x${output.rendering.height}`;
    await appendFile(process.env.GITHUB_STEP_SUMMARY, [
      "## Chromium and WebKit synthetic benchmark",
      "",
      "| Engine | Median total | P95 total | Peak child RSS | Child CPU | Success |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      `| Chromium | ${format(output.chromium.medianMs)} ms | ${format(output.chromium.p95Ms)} ms | ${format(output.chromium.peakRssMb)} MiB | ${format(output.chromium.childCpuMs)} ms | ${format(output.chromium.successRate * 100)}% |`,
      `| WebKit | ${format(output.webkit.medianMs)} ms | ${format(output.webkit.p95Ms)} ms | ${format(output.webkit.peakRssMb)} MiB | ${format(output.webkit.childCpuMs)} ms | ${format(output.webkit.successRate * 100)}% |`,
      "",
      `Chromium startup median/p95: ${format(output.chromium.startup.median)}/${format(output.chromium.startup.p95)} ms; screenshot median/p95: ${format(output.chromium.screenshot.median)}/${format(output.chromium.screenshot.p95)} ms.`,
      `WebKit startup median/p95: ${format(output.webkit.startup.median)}/${format(output.webkit.startup.p95)} ms; screenshot median/p95: ${format(output.webkit.screenshot.median)}/${format(output.webkit.screenshot.p95)} ms.`,
      `Timeout cleanup: Chromium ${output.chromium.timeout.failure} in ${format(output.chromium.timeout.durationMs)} ms with ${output.chromium.timeout.remainingNewPids.length} remaining processes; WebKit ${output.webkit.timeout.failure} in ${format(output.webkit.timeout.durationMs)} ms with ${output.webkit.timeout.remainingNewPids.length} remaining processes.`,
      "",
      `Rendering comparison: ${rendering}.`,
      "",
      `Each engine runs ${cases.length} synthetic cases across ${rounds} rounds. The first round is cold and later rounds retain only host caches; every application capture still launches a fresh browser. CI runner results do not predict Amsterdam VPS performance.`,
      "",
    ].join("\n"));
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    const concise = [
      `Chromium median/p95 ${output.chromium.medianMs.toFixed(1)}/${output.chromium.p95Ms.toFixed(1)} ms, peak RSS ${output.chromium.peakRssMb.toFixed(1)} MiB, CPU ${output.chromium.childCpuMs.toFixed(1)} ms`,
      `WebKit median/p95 ${output.webkit.medianMs.toFixed(1)}/${output.webkit.p95Ms.toFixed(1)} ms, peak RSS ${output.webkit.peakRssMb.toFixed(1)} MiB, CPU ${output.webkit.childCpuMs.toFixed(1)} ms`,
      `pixel difference ${output.rendering.differentPixels ?? "dimensions differ"}/${output.rendering.totalPixels ?? "n/a"}`,
      `timeout cleanup remaining processes Chromium ${output.chromium.timeout.remainingNewPids.length}, WebKit ${output.webkit.timeout.remainingNewPids.length}`,
    ].join("; ");
    console.log(`::notice title=Browser engine benchmark::${concise}`);
  }
  console.log(serialized);
  if (
    output.chromium.successRate !== 1 || output.webkit.successRate !== 1 ||
    !String(output.chromium.timeout.failure).includes("timeout") || !String(output.webkit.timeout.failure).includes("timeout") ||
    output.chromium.timeout.remainingNewPids.length || output.webkit.timeout.remainingNewPids.length
  ) process.exitCode = 1;
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
