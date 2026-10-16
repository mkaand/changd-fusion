import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
const pocDir = path.join(repositoryRoot, "experiments", "servo-capture-contract-poc");
const fixture = path.join(scriptDir, "servo-benchmark-fixture.mjs");
const PROCESS_TIMEOUT_MS = 90_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const TERMINATION_GRACE_MS = 5_000;

function describeExit(command, code, signal, stderr, stdout) {
  const status = signal ? `terminated by ${signal}` : `exited ${code}`;
  return `${command} ${status}: ${stderr || stdout}`;
}

function terminateProcess(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        terminateProcess(child, "SIGTERM");
      } catch (error) {
        finish(reject, error);
        return;
      }
      setTimeout(() => {
        try {
          terminateProcess(child, "SIGKILL");
        } catch (error) {
          finish(reject, error);
        }
      }, TERMINATION_GRACE_MS).unref();
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => finish(reject, error));
    child.once("close", (code, signal) => {
      if (code === 0 && !timedOut) finish(resolve, { stdout, stderr });
      else {
        const prefix = timedOut ? `${command} timed out after ${options.timeoutMs ?? PROCESS_TIMEOUT_MS}ms; ` : "";
        finish(reject, new Error(`${prefix}${describeExit(command, code, signal, stderr, stdout)}`));
      }
    });
  });
}

async function ensurePrivateRuntimeDirectory() {
  const current = process.env.XDG_RUNTIME_DIR;
  if (current) {
    try {
      const details = await stat(current);
      if (details.isDirectory() && details.uid === process.getuid?.() && (details.mode & 0o777) === 0o700) {
        return { path: current, created: false };
      }
    } catch {
      // Create a private replacement below rather than passing an invalid path to Servo.
    }
  }

  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "servo-runtime-"));
  await chmod(runtimeDir, 0o700);
  return { path: runtimeDir, created: true };
}

const runtimeDirectory = await ensurePrivateRuntimeDirectory();
const childEnvironment = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory.path };
const fixtureServer = spawn(process.execPath, [fixture], {
  cwd: repositoryRoot,
  env: childEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32"
});
let fixtureOutput = "";
fixtureServer.stdout.on("data", chunk => { fixtureOutput += chunk; });
fixtureServer.stderr.on("data", chunk => { fixtureOutput += chunk; });

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture did not start: ${fixtureOutput}`)), 5_000);
    const check = () => {
      if (fixtureOutput.includes("fixture-ready:4173")) {
        clearTimeout(timer);
        resolve();
      }
    };
    fixtureServer.stdout.on("data", check);
    check();
  });

  await run("cargo", ["build", "--quiet"], {
    cwd: pocDir,
    env: childEnvironment,
    timeoutMs: BUILD_TIMEOUT_MS
  });
  const binary = path.join(pocDir, "target", "debug", "servo-capture-contract-poc");
  const { stdout } = await run(binary, ["--allow-fixture-private", "http://127.0.0.1:4173/javascript", "JavaScript rendered"], {
    cwd: pocDir,
    env: childEnvironment
  });
  const result = JSON.parse(stdout);
  if (!result.sameSession || !result.textMatched || !result.png?.valid || result.png.width !== 1280 || result.png.height !== 800) {
    throw new Error(`unexpected same-session result: ${stdout}`);
  }
  if (!String(result.capabilityLimits?.httpStatus).includes("not exposed")) {
    throw new Error("POC must not claim HTTP status support");
  }
  process.stdout.write(`servo-contract-poc: ${JSON.stringify(result)}\n`);
} finally {
  try {
    terminateProcess(fixtureServer, "SIGTERM");
    const exited = await Promise.race([
      new Promise(resolve => fixtureServer.once("close", resolve)),
      new Promise(resolve => setTimeout(() => resolve(false), TERMINATION_GRACE_MS))
    ]);
    if (exited === false) {
      terminateProcess(fixtureServer, "SIGKILL");
      await new Promise(resolve => fixtureServer.once("close", resolve));
    }
  } finally {
    if (runtimeDirectory.created) await rm(runtimeDirectory.path, { recursive: true, force: true });
  }
}
