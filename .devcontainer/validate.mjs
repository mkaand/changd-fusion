import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (
  process.getuid() !== 1000 ||
  process.getgid() !== 1000 ||
  process.env.HOME !== "/home/node"
)
  throw Error("Dev Container requires node UID/GID 1000 and HOME=/home/node");
for (const dir of [
  "/home/node",
  "/home/node/.config/vscode-dev-containers",
  "/home/node/.vscode-server",
  path.join(root, ".preview"),
]) {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.uid !== 1000 || info.mode & 0o077)
    throw Error("Private development directory ownership is invalid");
  await access(dir, constants.R_OK | constants.W_OK | constants.X_OK);
}
// Check writable checkout before a long npm install. Never chmod/chown the repository.
await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
console.log(
  "PASS: non-root HOME, VS Code directories and private runtime ownership",
);
