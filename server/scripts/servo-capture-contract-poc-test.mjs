import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
const pocDir = path.join(repositoryRoot, "experiments", "servo-capture-contract-poc");
const fixture = path.join(scriptDir, "servo-benchmark-fixture.mjs");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

const fixtureServer = spawn(process.execPath, [fixture], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
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

  const { stdout } = await run("cargo", ["run", "--quiet", "--", "--allow-fixture-private", "http://127.0.0.1:4173/javascript", "JavaScript rendered"], { cwd: pocDir });
  const result = JSON.parse(stdout);
  if (!result.sameSession || !result.textMatched || !result.png?.valid || result.png.width !== 1280 || result.png.height !== 800) {
    throw new Error(`unexpected same-session result: ${stdout}`);
  }
  if (!String(result.capabilityLimits?.httpStatus).includes("not exposed")) {
    throw new Error("POC must not claim HTTP status support");
  }
  process.stdout.write(`servo-contract-poc: ${JSON.stringify(result)}\n`);
} finally {
  fixtureServer.kill("SIGTERM");
  await new Promise(resolve => fixtureServer.once("close", resolve));
}
