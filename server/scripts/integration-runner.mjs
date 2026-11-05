import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
const files = readdirSync("test/integration")
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => "test/integration/" + f);
if (!files.length) throw Error("No integration tests found");
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    "--test-reporter=tap",
    "--test-timeout=90000",
    ...files,
  ],
  { stdio: "inherit", detached: true },
);
let timedOut = false;
let killTimer;
let terminating = false;
function terminate() {
  if (terminating) return;
  terminating = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  killTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 5000);
}
const timer = setTimeout(
  () => {
    timedOut = true;
    console.error(
      "Integration suite exceeded 8 minutes; terminating test/browser process group. Inspect the last reported test and cleanup hooks.",
    );
    terminate();
  },
  8 * 60 * 1000,
);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, terminate);
child.on("error", (error) => {
  console.error(error.message);
  clearTimeout(timer);
  clearTimeout(killTimer);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (terminating) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
  clearTimeout(timer);
  clearTimeout(killTimer);
  if (signal) console.error(`Integration process stopped by ${signal}`);
  process.exitCode = timedOut ? 124 : (code ?? 1);
});
