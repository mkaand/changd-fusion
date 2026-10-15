import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(process.env.BENCHMARK_OUTPUT_DIR || path.join(process.cwd(), "servo-benchmark-results"));
const servoImage = process.env.SERVO_IMAGE || "ghcr.io/konippi/servo-fetch@sha256:cd026015488a45bb1647c61d75bf94731e78b1428ffc091c725e23409ec6ec7a";
const chromiumImage = process.env.CHROMIUM_IMAGE || "changd-fusion-api:servo-benchmark";
const measuredRuns = Number(process.env.BENCHMARK_RUNS || 7);
const resourceLimits = { cpus: "2", memory: "1024m", pids: "256", shm: "256m" };
const id = randomUUID().replaceAll("-", "").slice(0, 12);
const networkName = `servo-benchmark-${id}`;
const fixtureName = `servo-fixture-${id}`;
const workDir = await mkdtemp(path.join(os.tmpdir(), "servo-benchmark-"));
const screenshotsDir = path.join(outputDir, "screenshots");
const records = [];
const representative = new Map();

const fixtures = [
  { name: "static", path: "/static", settleMs: 250, fullPage: false, probes: [{ x: 4, y: 4, rgb: [15, 23, 42] }] },
  { name: "javascript", path: "/javascript", settleMs: 250, fullPage: false, probes: [{ x: 4, y: 4, rgb: [37, 99, 235] }] },
  { name: "heavy", path: "/heavy", settleMs: 250, fullPage: false, probes: [{ x: 4, y: 4, rgb: [49, 46, 129] }] },
  { name: "media", path: "/media", settleMs: 250, fullPage: false, probes: [{ x: 30, y: 160, rgb: [14, 165, 233] }] },
  { name: "long", path: "/long", settleMs: 250, fullPage: true, probes: [{ x: 4, y: 4, rgb: [244, 194, 194] }, { x: 20, y: 790, rgb: [217, 244, 194] }] },
  { name: "dynamic", path: "/dynamic", settleMs: 600, fullPage: false, probes: [{ x: 4, y: 4, rgb: [22, 163, 74] }] },
  { name: "slow", path: "/slow", settleMs: 250, fullPage: false, probes: [{ x: 4, y: 4, rgb: [234, 179, 8] }] },
];

const engines = ["chromium", "servo"];

const run = (command, args, { allowFailure = false, timeoutMs = 0 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const append = (current, chunk) => (current + chunk.toString()).slice(-65_536);
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  let timer;
  if (timeoutMs > 0) timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.on("error", reject);
  child.on("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    const result = { code: code ?? 128, signal, stdout, stderr };
    if (!allowFailure && result.code !== 0) {
      reject(new Error(`${command} failed with ${result.code}${signal ? ` (${signal})` : ""}: ${stderr.slice(-2_000)}`));
    } else resolve(result);
  });
});

const docker = (args, options) => run("docker", args, options);
const envArgs = [
  "-e", "HTTP_PROXY=", "-e", "HTTPS_PROXY=", "-e", "ALL_PROXY=",
  "-e", "http_proxy=", "-e", "https_proxy=", "-e", "all_proxy=",
  "-e", "NO_PROXY=*", "-e", "no_proxy=*",
  "-e", "HOME=/tmp", "-e", "XDG_CACHE_HOME=/tmp/cache", "-e", "XDG_CONFIG_HOME=/tmp/config",
];

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
};
const median = (values) => percentile(values, 50);
const round = (value, digits = 1) => value == null ? null : Number(value.toFixed(digits));
const formatMs = (value) => value == null ? "n/a" : `${round(value)} ms`;
const formatMiB = (value) => value == null ? "n/a" : `${round(value / 1024 / 1024)} MiB`;

const inspectPng = async (file, fixture) => {
  try {
    const data = await readFile(file);
    const png = PNG.sync.read(data);
    const expectedHeight = fixture.fullPage ? 7_040 : 800;
    const dimensionsMatched = png.width === 1_280 && (fixture.fullPage ? png.height >= 7_000 : png.height === expectedHeight);
    const colorProbes = (fixture.probes || []).map((probe) => {
      const index = (probe.y * png.width + probe.x) * 4;
      const actual = [...png.data.subarray(index, index + 3)];
      return {
        x: probe.x, y: probe.y, expected: probe.rgb, actual,
        matched: actual.every((value, channel) => Math.abs(value - probe.rgb[channel]) <= 5),
      };
    });
    return {
      valid: true,
      bytes: data.length,
      width: png.width,
      height: png.height,
      dimensionsMatched,
      colorProbes,
      correctness: dimensionsMatched && colorProbes.every((probe) => probe.matched) ? "PASS" : "PARTIAL",
    };
  } catch (error) {
    return { valid: false, correctness: "FAIL", error: String(error.message || error) };
  }
};

const dockerSecurityArgs = (sampleDir) => [
  "--network", networkName,
  "--read-only",
  "--security-opt", `seccomp=${path.resolve(scriptDir, "../../docker/chromium-seccomp.json")}`,
  "--pids-limit", resourceLimits.pids,
  "--memory", resourceLimits.memory,
  "--cpus", resourceLimits.cpus,
  "--shm-size", resourceLimits.shm,
  "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m",
  "--mount", `type=bind,src=${scriptDir}/servo-benchmark-wrapper.sh,dst=/bench/wrapper.sh,readonly`,
  "--mount", `type=bind,src=${sampleDir},dst=/output`,
  ...envArgs,
];

const runCapture = async ({ engine, fixture, phase, index, timeoutSeconds = 20, expectedFailure = false }) => {
  const sampleDir = path.join(workDir, `${fixture.name}-${engine}-${phase}-${index}`);
  await mkdir(sampleDir, { recursive: true });
  await chmod(sampleDir, 0o777);
  const screenshotFile = path.join(sampleDir, "screenshot.png");
  const metricsFile = path.join(sampleDir, "metrics.json");
  const stagesFile = path.join(sampleDir, "stages.json");
  const url = `http://fixture:4173${fixture.path}`;
  const containerName = `servo-bench-${engine}-${id}-${fixture.name}-${phase}-${index}`.slice(0, 63);
  const common = [
    "run", "--rm", "--name", containerName,
    ...dockerSecurityArgs(sampleDir),
  ];
  let command;
  if (engine === "chromium") {
    common.push(
      "--mount", `type=bind,src=${scriptDir}/servo-benchmark-chromium.mjs,dst=/app/benchmark-chromium.mjs,readonly`,
      "--entrypoint", "/bench/wrapper.sh", chromiumImage,
    );
    command = [
      "/output/metrics.json", "node", "/app/benchmark-chromium.mjs", url,
      "/output/screenshot.png", "/output/stages.json", String(fixture.fullPage),
      String(fixture.settleMs), String(timeoutSeconds * 1_000),
    ];
  } else {
    common.push("--cap-drop=ALL", "--security-opt", "no-new-privileges:true", "--entrypoint", "/bench/wrapper.sh", servoImage);
    command = [
      "/output/metrics.json", "servo-fetch", "--allow-private-addresses",
      "--format", "png", "--timeout", String(timeoutSeconds), "--settle", String(fixture.settleMs),
      "-o", "/output/screenshot.png",
      ...(fixture.fullPage ? ["--full-page"] : []),
      url,
    ];
  }
  const started = performance.now();
  const processResult = await docker([...common, ...command], { allowFailure: true, timeoutMs: (timeoutSeconds + 20) * 1_000 });
  const endToEndMs = performance.now() - started;
  let metrics = null;
  let stages = null;
  try { metrics = JSON.parse(await readFile(metricsFile, "utf8")); } catch {}
  try { stages = JSON.parse(await readFile(stagesFile, "utf8")); } catch {}
  const hasScreenshot = await access(screenshotFile).then(() => true, () => false);
  const png = hasScreenshot ? await inspectPng(screenshotFile, fixture) : null;
  const succeeded = processResult.code === 0 && metrics?.exitCode === 0 && hasScreenshot && png?.valid === true;
  const record = {
    engine, fixture: fixture.name, phase, index, expectedFailure,
    succeeded, processExitCode: processResult.code, endToEndMs,
    commandWallMs: metrics?.commandWallMs ?? null,
    startupMs: stages?.startupMs ?? null,
    navigationMs: stages?.navigationMs ?? null,
    settleMs: stages?.settleMs ?? null,
    screenshotMs: stages?.screenshotMs ?? null,
    cpuMs: metrics?.cpuMs ?? null,
    peakProcessRssBytes: metrics?.peakProcessRssBytes ?? null,
    peakCgroupBytes: metrics?.peakCgroupBytes ?? null,
    remainingProcesses: metrics?.remainingProcesses ?? null,
    png,
  };
  records.push(record);

  if (phase === "warm" && index === 1 && succeeded) {
    const destination = path.join(screenshotsDir, `${fixture.name}-${engine}.png`);
    await copyFile(screenshotFile, destination);
    representative.set(`${fixture.name}:${engine}`, destination);
  }
  if (!expectedFailure && !succeeded) {
    const diagnostic = processResult.stderr.trim().slice(-2_000).replaceAll(url, "<synthetic-fixture>");
    throw new Error(`${engine} ${fixture.name} ${phase} capture failed (container ${processResult.code}, command ${metrics?.exitCode ?? "unknown"})${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  if (metrics?.remainingProcesses !== 0) {
    throw new Error(`${engine} ${fixture.name} left ${metrics?.remainingProcesses ?? "unknown"} process(es)`);
  }
  return record;
};

const compareScreenshots = async (fixture) => {
  const chromiumPath = representative.get(`${fixture.name}:chromium`);
  const servoPath = representative.get(`${fixture.name}:servo`);
  if (!chromiumPath || !servoPath) return { status: "FAIL", reason: "missing representative screenshot" };
  const chromium = PNG.sync.read(await readFile(chromiumPath));
  const servo = PNG.sync.read(await readFile(servoPath));
  if (chromium.width !== servo.width || chromium.height !== servo.height) {
    return {
      status: "PARTIAL", reason: "dimensions differ",
      chromiumDimensions: `${chromium.width}x${chromium.height}`,
      servoDimensions: `${servo.width}x${servo.height}`,
      pixelDifferencePercent: null,
    };
  }
  const differentPixels = pixelmatch(chromium.data, servo.data, null, chromium.width, chromium.height, { threshold: 0.1 });
  return {
    status: "PASS",
    chromiumDimensions: `${chromium.width}x${chromium.height}`,
    servoDimensions: `${servo.width}x${servo.height}`,
    differentPixels,
    pixelDifferencePercent: round((differentPixels / (chromium.width * chromium.height)) * 100, 3),
  };
};

const summarize = (comparisons) => {
  const perFixture = fixtures.map((fixture) => {
    const result = { fixture: fixture.name, fullPage: fixture.fullPage, engines: {}, visual: comparisons[fixture.name] };
    for (const engine of engines) {
      const warm = records.filter((record) => record.engine === engine && record.fixture === fixture.name && record.phase === "warm");
      const cold = records.find((record) => record.engine === engine && record.fixture === fixture.name && record.phase === "cold");
      result.engines[engine] = {
        coldEndToEndMs: round(cold?.endToEndMs),
        medianCaptureMs: round(median(warm.map((record) => record.commandWallMs).filter(Number.isFinite))),
        p95CaptureMs: round(percentile(warm.map((record) => record.commandWallMs).filter(Number.isFinite), 95)),
        medianContainerEndToEndMs: round(median(warm.map((record) => record.endToEndMs))),
        p95ContainerEndToEndMs: round(percentile(warm.map((record) => record.endToEndMs), 95)),
        medianStartupMs: round(median(warm.map((record) => record.startupMs).filter(Number.isFinite))),
        medianNavigationMs: round(median(warm.map((record) => record.navigationMs).filter(Number.isFinite))),
        medianScreenshotMs: round(median(warm.map((record) => record.screenshotMs).filter(Number.isFinite))),
        medianCpuMs: round(median(warm.map((record) => record.cpuMs).filter(Number.isFinite))),
        peakProcessRssBytes: Math.max(...warm.map((record) => record.peakProcessRssBytes).filter(Number.isFinite)),
        peakCgroupBytes: Math.max(...warm.map((record) => record.peakCgroupBytes).filter(Number.isFinite)),
        successRate: round((warm.filter((record) => record.succeeded).length / warm.length) * 100),
        correctness: warm.every((record) => record.png?.correctness === "PASS") ? "PASS" : "PARTIAL",
        screenshotBytes: warm[0]?.png?.bytes ?? null,
      };
    }
    result.speedRatioServoOverChromium = round(result.engines.servo.medianCaptureMs / result.engines.chromium.medianCaptureMs, 3);
    return result;
  });
  const overall = {};
  for (const engine of engines) {
    const warm = records.filter((record) => record.engine === engine && record.phase === "warm");
    overall[engine] = {
      samples: warm.length,
      medianCaptureMs: round(median(warm.map((record) => record.commandWallMs).filter(Number.isFinite))),
      p95CaptureMs: round(percentile(warm.map((record) => record.commandWallMs).filter(Number.isFinite), 95)),
      medianContainerEndToEndMs: round(median(warm.map((record) => record.endToEndMs))),
      p95ContainerEndToEndMs: round(percentile(warm.map((record) => record.endToEndMs), 95)),
      medianCpuMs: round(median(warm.map((record) => record.cpuMs).filter(Number.isFinite))),
      peakProcessRssBytes: Math.max(...warm.map((record) => record.peakProcessRssBytes).filter(Number.isFinite)),
      peakCgroupBytes: Math.max(...warm.map((record) => record.peakCgroupBytes).filter(Number.isFinite)),
      successRate: round((warm.filter((record) => record.succeeded).length / warm.length) * 100),
    };
  }
  return { perFixture, overall };
};

const markdown = (result) => {
  const lines = [
    "# Servo Cloud Benchmark V1", "",
    `Measured on \`${result.environment.platform} ${result.environment.arch}\` with ${result.environment.cpuCount} logical CPUs.`,
    `Each normal fixture used one cold sample, one unmeasured warm-up, and ${measuredRuns} measured fresh-container captures per engine.`,
    "", "## Results", "",
    "| Fixture | Chromium capture median / p95 | Servo capture median / p95 | Servo / Chromium | Chromium peak RSS | Servo peak RSS | Chromium CPU | Servo CPU | Visual |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const entry of result.summary.perFixture) {
    lines.push(`| ${entry.fixture}${entry.fullPage ? " (full page)" : ""} | ${formatMs(entry.engines.chromium.medianCaptureMs)} / ${formatMs(entry.engines.chromium.p95CaptureMs)} | ${formatMs(entry.engines.servo.medianCaptureMs)} / ${formatMs(entry.engines.servo.p95CaptureMs)} | ${entry.speedRatioServoOverChromium}x | ${formatMiB(entry.engines.chromium.peakProcessRssBytes)} | ${formatMiB(entry.engines.servo.peakProcessRssBytes)} | ${formatMs(entry.engines.chromium.medianCpuMs)} | ${formatMs(entry.engines.servo.medianCpuMs)} | ${entry.visual.status}${entry.visual.pixelDifferencePercent == null ? "" : ` (${entry.visual.pixelDifferencePercent}% pixels)`} |`);
  }
  lines.push(
    "", "## Overall", "",
    `- Chromium capture process: median ${formatMs(result.summary.overall.chromium.medianCaptureMs)}, p95 ${formatMs(result.summary.overall.chromium.p95CaptureMs)}, peak process-tree RSS ${formatMiB(result.summary.overall.chromium.peakProcessRssBytes)}, ${result.summary.overall.chromium.successRate}% success.`,
    `- Servo capture process: median ${formatMs(result.summary.overall.servo.medianCaptureMs)}, p95 ${formatMs(result.summary.overall.servo.p95CaptureMs)}, peak process-tree RSS ${formatMiB(result.summary.overall.servo.peakProcessRssBytes)}, ${result.summary.overall.servo.successRate}% success.`,
    `- Fresh-container end-to-end medians (reported separately because image/rootfs startup is not engine capture time): Chromium ${formatMs(result.summary.overall.chromium.medianContainerEndToEndMs)}, Servo ${formatMs(result.summary.overall.servo.medianContainerEndToEndMs)}.`,
    "", "## Failure and timeout diagnostics", "",
    "| Engine | Fixture | Rejected as failure | Process exit | Remaining processes |",
    "| --- | --- | --- | ---: | ---: |",
  );
  for (const record of records.filter((entry) => entry.expectedFailure)) {
    lines.push(`| ${record.engine} | ${record.fixture} | ${record.succeeded ? "NO" : "yes"} | ${record.processExitCode} | ${record.remainingProcesses ?? "unavailable"} |`);
  }
  lines.push(
    "", "## Interpretation boundaries", "",
    "- This is an isolated synthetic benchmark, not certification for Changd Fusion production egress security or feature parity.",
    "- Both engines ran on the same Docker internal network, fixture content, concurrency (one), resource limits, viewport target, and settling delays.",
    "- Servo does not expose navigation/startup/screenshot stage timings separately; those fields are reported as unavailable rather than estimated.",
    "- Font and engine rendering differences make pixel-identical output neither expected nor required; fixture-specific state and completeness probes are also recorded in JSON.",
  );
  return `${lines.join("\n")}\n`;
};

const writeChecksums = async () => {
  const files = ["benchmark-results.json", "benchmark-summary.md"];
  for (const name of await readdir(screenshotsDir)) files.push(path.join("screenshots", name));
  const lines = [];
  for (const name of files.sort()) {
    const digest = createHash("sha256").update(await readFile(path.join(outputDir, name))).digest("hex");
    lines.push(`${digest}  ${name}`);
  }
  await writeFile(path.join(outputDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
};

let primaryError;
try {
  if (!Number.isInteger(measuredRuns) || measuredRuns < 1) throw new Error("BENCHMARK_RUNS must be a positive integer");
  await mkdir(screenshotsDir, { recursive: true });
  await chmod(path.join(scriptDir, "servo-benchmark-wrapper.sh"), 0o755);
  await docker(["image", "inspect", servoImage]);
  await docker(["image", "inspect", chromiumImage]);
  await docker(["network", "create", "--internal", "--driver", "bridge", networkName]);
  const networkInspection = JSON.parse((await docker(["network", "inspect", networkName])).stdout)[0];
  if (networkInspection.Internal !== true) throw new Error("benchmark network is not internal");
  await docker([
    "run", "-d", "--rm", "--name", fixtureName, "--network", networkName, "--network-alias", "fixture",
    "--read-only", "--cap-drop=ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64", "--memory", "256m", "--cpus", "0.5", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m",
    "--mount", `type=bind,src=${scriptDir}/servo-benchmark-fixture.mjs,dst=/bench/fixture.mjs,readonly`,
    ...envArgs, "--entrypoint", "node", chromiumImage, "/bench/fixture.mjs",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
    const health = await docker(["exec", fixtureName, "node", "-e", "fetch('http://127.0.0.1:4173/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"], { allowFailure: true });
    ready = health.code === 0;
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("fixture server did not become ready");

  for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex += 1) {
    const fixture = fixtures[fixtureIndex];
    const orderedEngines = fixtureIndex % 2 === 0 ? engines : [...engines].reverse();
    for (const engine of orderedEngines) {
      process.stdout.write(`benchmark:${fixture.name}:${engine}:cold\n`);
      await runCapture({ engine, fixture, phase: "cold", index: 1 });
      process.stdout.write(`benchmark:${fixture.name}:${engine}:warmup\n`);
      await runCapture({ engine, fixture, phase: "warmup", index: 1 });
      for (let index = 1; index <= measuredRuns; index += 1) {
        process.stdout.write(`benchmark:${fixture.name}:${engine}:warm:${index}/${measuredRuns}\n`);
        await runCapture({ engine, fixture, phase: "warm", index });
      }
    }
  }

  for (const engine of engines) {
    await runCapture({ engine, fixture: { name: "invalid-response", path: "/failure", settleMs: 0, fullPage: false }, phase: "diagnostic", index: 1, timeoutSeconds: 4, expectedFailure: true });
    await runCapture({ engine, fixture: { name: "timeout", path: "/timeout", settleMs: 0, fullPage: false }, phase: "diagnostic", index: 1, timeoutSeconds: 2, expectedFailure: true });
  }

  const comparisons = {};
  for (const fixture of fixtures) comparisons[fixture.name] = await compareScreenshots(fixture);
  const dockerVersion = (await docker(["version", "--format", "{{.Server.Version}}"])) .stdout.trim();
  const imageInfo = {};
  for (const [engine, image] of [["servo", servoImage], ["chromium", chromiumImage]]) {
    const inspected = JSON.parse((await docker(["image", "inspect", image])).stdout)[0];
    imageInfo[engine] = { reference: image, id: inspected.Id, repoDigests: inspected.RepoDigests || [], labels: inspected.Config?.Labels || {} };
  }
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: os.platform(), arch: os.arch(), cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || "unknown", totalMemoryBytes: os.totalmem(),
      dockerVersion, networkInternal: true, concurrency: 1, resourceLimits,
    },
    provenance: {
      servoVersion: "0.15.1", servoReleaseCommit: "fa90cf0b6f76def0b7d5e9baeb13b9aceeb232b4",
      auditedUpstreamCommit: "914241df0c2deed3b1bcb10d4d637a9a2049883d",
      servoManifestDigest: "sha256:cd026015488a45bb1647c61d75bf94731e78b1428ffc091c725e23409ec6ec7a",
      images: imageInfo,
    },
    methodology: { measuredRuns, coldRuns: 1, warmupRuns: 1, freshContainerPerCapture: true, viewport: "1280x800 where supported", fixtureNetwork: "Docker internal bridge" },
    summary: summarize(comparisons),
    records,
  };
  await writeFile(path.join(outputDir, "benchmark-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  const report = markdown(result);
  await writeFile(path.join(outputDir, "benchmark-summary.md"), report);
  await writeChecksums();
  if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, report, { flag: "a" });
  process.stdout.write(`benchmark-results:${path.join(outputDir, "benchmark-results.json")}\n`);
  process.stdout.write(`::notice title=Servo benchmark::Chromium median ${result.summary.overall.chromium.medianCaptureMs} ms / p95 ${result.summary.overall.chromium.p95CaptureMs} ms; Servo median ${result.summary.overall.servo.medianCaptureMs} ms / p95 ${result.summary.overall.servo.p95CaptureMs} ms\n`);
} catch (error) {
  primaryError = error;
  process.stderr.write(`benchmark-error:${error.stack || error}\n`);
} finally {
  await docker(["rm", "-f", fixtureName], { allowFailure: true }).catch(() => {});
  await docker(["network", "rm", networkName], { allowFailure: true }).catch(() => {});
  await rm(workDir, { recursive: true, force: true });
}

if (primaryError) process.exitCode = 1;
