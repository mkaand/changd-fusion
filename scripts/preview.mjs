import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export function previewOrigin(env) {
  if (
    env.CODESPACES !== "true" ||
    !/^[a-z0-9][a-z0-9-]{2,99}$/.test(env.CODESPACE_NAME ?? "")
  )
    throw Error("Codespaces context required");
  // Official public service suffix, never a user-supplied request header/domain.
  if (env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN !== "app.github.dev")
    throw Error("Unrecognized Codespaces forwarding domain");
  return `https://${env.CODESPACE_NAME}-3000.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
}
export async function privateFile(file) {
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error) => {
    if (error.code === "ELOOP") throw Error("Unsafe preview file permissions");
    throw error;
  });
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid())
      throw Error("Unsafe preview file permissions");
    return await fd.readFile("utf8");
  } finally {
    await fd.close();
  }
}
export async function privateHandle(file, append = false) {
  const fd = await open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (append ? constants.O_APPEND : 0),
    0o600,
  );
  const info = await fd.stat();
  if (!info.isFile() || info.mode & 0o077 || info.uid !== process.getuid()) {
    await fd.close();
    throw Error("Unsafe preview file permissions");
  }
  if (!append) await fd.truncate(0);
  return fd;
}
export async function privateWrite(file, value) {
  const fd = await privateHandle(file);
  try {
    await fd.writeFile(value);
  } finally {
    await fd.close();
  }
}
export async function stopPreview(root, timeoutMs = 75_000) {
  let pid, identity;
  const owned = async () => {
    const cmd = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return cmd.includes(path.join(root, ".devcontainer/serve.mjs")) &&
      (!identity || identity === start)
      ? start
      : null;
  };
  try {
    const text = (
      await privateFile(path.join(root, ".preview/supervisor.pid"))
    ).trim();
    if (!/^[1-9]\d{0,9}$/.test(text)) return;
    pid = Number(text);
    identity = await owned();
    if (!identity) return;
  } catch {
    return;
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (!(await owned())) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Only the previously identified preview supervisor; never unrelated containers/processes.
  try {
    if (await owned()) process.kill(pid, "SIGKILL");
  } catch {}
  throw Error("Preview shutdown deadline exceeded");
}
export async function previewSecrets(root) {
  const dir = path.join(root, ".preview");
  await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.mode & 0o077 || info.uid !== process.getuid())
    throw Error("Unsafe preview directory");
  const file = path.join(dir, "credentials.json");
  try {
    const value = JSON.parse(await privateFile(file));
    if (
      !/^[a-f0-9]{64}$/.test(value.jwt) ||
      !/^[a-f0-9]{64}$/.test(value.key) ||
      !/^[a-f0-9]{48}$/.test(value.password)
    )
      throw Error("Invalid preview credentials");
    return value;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const value = {
    jwt: randomBytes(32).toString("hex"),
    key: randomBytes(32).toString("hex"),
    password: randomBytes(24).toString("hex"),
  };
  await writeFile(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  return value;
}
export function verifyPorts(ports, origin) {
  if (
    !Array.isArray(ports) ||
    ports.length !== 1 ||
    Number(ports[0].sourcePort) !== 3000 ||
    ports[0].visibility !== "private"
  )
    throw Error("Only PRIVATE preview port 3000 is permitted");
  if (new URL(ports[0].browseUrl).origin !== origin)
    throw Error("Preview address mismatch");
}
const runCommand = (cmd, args, options) =>
  new Promise((resolve) => {
    execFile(cmd, args, options, (error, stdout) =>
      resolve({ error, status: error ? 1 : 0, stdout }),
    );
  });
export async function enforcePrivatePort(env, run = runCommand) {
  const origin = previewOrigin(env);
  const command = async (args, credentialsEnv = env) => {
    const r = await run("gh", args, {
      env: credentialsEnv,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 128_000,
    });
    if (r.error || r.status !== 0)
      throw Error("Private port verification unavailable");
    return r.stdout;
  };
  const setPrivate = [
    "codespace",
    "ports",
    "visibility",
    "3000:private",
    "-c",
    env.CODESPACE_NAME,
  ];
  // A Codespaces repository token may lack the codespace scope. An optional user-authorized
  // gh OAuth session is kept only in .preview/gh; never request or print a raw token.
  let credentialsEnv = env;
  try {
    await command(setPrivate);
  } catch {
    const { GITHUB_TOKEN, GH_TOKEN, ...oauthEnv } = env;
    credentialsEnv = oauthEnv;
    await command(setPrivate, credentialsEnv);
  }
  const ports = JSON.parse(
    await command(
      [
        "codespace",
        "ports",
        "-c",
        env.CODESPACE_NAME,
        "--json",
        "sourcePort,visibility,browseUrl",
      ],
      credentialsEnv,
    ),
  );
  verifyPorts(ports, origin);
  return origin;
}
