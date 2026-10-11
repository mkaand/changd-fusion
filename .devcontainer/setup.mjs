import "./validate.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const dir of ["server", "frontend"]) {
  for (const args of [
    ["ci", "--no-fund", "--no-audit"],
    ["run", "build"],
  ]) {
    const result = spawnSync("npm", args, {
      cwd: path.join(root, dir),
      stdio: "inherit",
      timeout: 300_000,
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=1536",
        npm_config_cache: path.join(root, ".preview/npm-cache"),
      },
    });
    if (result.error || result.status !== 0) process.exit(1);
  }
}
console.log(
  "Kurulum tamamlandı. Güvenli başlangıç denetimleri çalıştırılacak.",
);
