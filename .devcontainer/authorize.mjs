import { spawn } from "node:child_process";
import { mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewOrigin } from "../scripts/preview.mjs";
previewOrigin(process.env);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".preview/gh");
await mkdir(dir, { recursive: true, mode: 0o700 });
const info = await lstat(dir);
if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid())
  throw Error("Unsafe OAuth directory");
const { GITHUB_TOKEN, GH_TOKEN, ...baseEnv } = process.env;
console.log(
  "GitHub hesabınızla Codespaces PRIVATE port denetimini yetkilendirin. Tokenı kopyalamayın veya paylaşmayın.",
);
const child = spawn(
  "gh",
  [
    "auth",
    "login",
    "--hostname",
    "github.com",
    "--git-protocol",
    "https",
    "--web",
    "--scopes",
    "codespace",
  ],
  {
    env: { ...baseEnv, GH_CONFIG_DIR: dir },
    stdio: "inherit",
  },
);
const timer = setTimeout(() => child.kill("SIGTERM"), 180_000);
const code = await new Promise((resolve) => {
  child.once("exit", resolve);
  child.once("error", () => resolve(1));
});
clearTimeout(timer);
if (code !== 0) process.exit(1);
const start = spawn(
  process.execPath,
  [path.join(root, ".devcontainer/start.mjs")],
  { stdio: "inherit" },
);
process.exit(
  await new Promise((resolve) => {
    start.once("exit", (code) => resolve(code ?? 1));
    start.once("error", () => resolve(1));
  }),
);
