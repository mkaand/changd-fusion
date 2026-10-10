import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  previewOrigin,
  privateFile,
  privateHandle,
  privateWrite,
} from "../scripts/preview.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
previewOrigin(process.env);
const script = path.join(root, ".devcontainer/serve.mjs");
const state = path.join(root, ".preview");
let running = false;
let supervisorPid;
try {
  const pid = Number(await privateFile(path.join(state, "supervisor.pid")));
  const cmd = await readFile(`/proc/${pid}/cmdline`, "utf8");
  running = cmd.split("\0").includes(script);
  if (running) supervisorPid = pid;
} catch {}
if (!running) {
  const log = await privateHandle(path.join(state, "startup.log"), true);
  const child = spawn(process.execPath, [script], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.unref();
  supervisorPid = child.pid;
  await log.close();
  await privateWrite(path.join(state, "supervisor.pid"), String(child.pid));
}
const deadline = Date.now() + 120_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const marker = JSON.parse(
      await privateFile(path.join(state, "ready.json")),
    );
    if (marker.pid !== supervisorPid) throw Error("Preview is not ready");
    const r = await fetch("http://127.0.0.1:3000/api/v1/health", {
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) {
  console.error(
    "Önizleme başlamadı. Codespace içindeki .preview/startup.log dosyasını inceleyin. Sandbox veya PRIVATE port kontrolü devre dışı bırakılmaz.",
  );
  process.exit(1);
}
console.log(
  "Changd Fusion hazır. Ports sekmesinde yalnızca 3000 / Private bağlantısını açın. Giriş bilgileri yalnızca .preview/login.txt dosyanızdadır.",
);
