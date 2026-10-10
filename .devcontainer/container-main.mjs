import path from "node:path";
import { fileURLToPath } from "node:url";
import { stopPreview } from "../scripts/preview.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// PID 1's child stays alive for lifecycle hooks and forwards shutdown to the detached supervisor.
const alive = setInterval(() => {}, 60_000);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(alive);
    try {
      await stopPreview(root);
      process.exit(0);
    } catch {
      console.error("Önizleme kapanış süresi aşıldı.");
      process.exit(1);
    }
  });
