import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  chmod,
  symlink,
  readFile,
  lstat,
  mkdir,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  previewOrigin,
  previewSecrets,
  privateFile,
  verifyPorts,
  enforcePrivatePort,
  privateWrite,
  stopPreview,
} from "./preview.mjs";
const env = {
  CODESPACES: "true",
  CODESPACE_NAME: "synthetic-preview-fixture",
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev",
};
const origin = previewOrigin(env);
test("Codespaces origin comes only from validated official context, never a request host", () => {
  assert.equal(origin, "https://synthetic-preview-fixture-3000.app.github.dev");
  for (const override of [
    { CODESPACES: "false" },
    { CODESPACE_NAME: "../../invalid" },
    { CODESPACE_NAME: "fixture.example.com" },
    { GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "example.com" },
  ])
    assert.throws(() => previewOrigin({ ...env, ...override }));
});
test("private output cannot follow symlinks or overwrite a shared file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusion-private-output-"));
  try {
    const target = path.join(root, "target");
    const link = path.join(root, "link");
    await privateWrite(target, "synthetic-private-fixture");
    await symlink(target, link);
    await assert.rejects(privateWrite(link, "replacement"));
    assert.equal(await privateFile(target), "synthetic-private-fixture");
    await chmod(target, 0o644);
    await assert.rejects(privateWrite(target, "replacement"), /permissions/);
    assert.equal(await readFile(target, "utf8"), "synthetic-private-fixture");
    const fifo = path.join(root, "fifo");
    execFileSync("mkfifo", [fifo], { timeout: 5000 });
    await assert.rejects(privateFile(fifo), /permissions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("port privacy requires exactly one private 3000 endpoint with matching HTTPS origin", () => {
  const port = { sourcePort: 3000, visibility: "private", browseUrl: origin };
  verifyPorts([port], origin);
  for (const ports of [
    [],
    [{ ...port, visibility: "public" }],
    [{ ...port, visibility: "org" }],
    [port, { ...port, sourcePort: 5432 }],
    [{ ...port, browseUrl: "https://example.com" }],
    [{ ...port, browseUrl: origin.replace("https:", "http:") }],
  ])
    assert.throws(() => verifyPorts(ports, origin));
});
test("private port enforcement sets private, reads actual state and fails closed on missing permission", async () => {
  const calls = [];
  const run = async (_cmd, args, options) => {
    calls.push(args);
    assert.equal(options.timeout, 20000);
    return {
      status: 0,
      stdout: args.includes("visibility")
        ? ""
        : JSON.stringify([
            { sourcePort: 3000, visibility: "private", browseUrl: origin },
          ]),
    };
  };
  assert.equal(await enforcePrivatePort(env, run), origin);
  assert.ok(calls[0].includes("3000:private"));
  assert.ok(!calls.flat().includes("public"));
  await assert.rejects(
    enforcePrivatePort(env, async () => ({ status: 1, stdout: "" })),
    /verification unavailable/,
  );
  let fallback = false;
  await enforcePrivatePort(
    { ...env, GITHUB_TOKEN: "synthetic-repository-token" },
    async (_cmd, args, options) => {
      if (options.env.GITHUB_TOKEN) return { status: 1, stdout: "" };
      fallback = true;
      return {
        status: 0,
        stdout: args.includes("visibility")
          ? ""
          : JSON.stringify([
              { sourcePort: 3000, visibility: "private", browseUrl: origin },
            ]),
      };
    },
  );
  assert.equal(fallback, true);
});
test("preview credentials remain stable on resume and are private random values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusion-preview-test-"));
  try {
    const a = await previewSecrets(root),
      b = await previewSecrets(root);
    assert.ok(a.password === b.password && a.jwt === b.jwt && a.key === b.key);
    assert.ok(a.jwt !== a.key && a.password.length === 48);
    assert.equal(
      (await lstat(path.join(root, ".preview/credentials.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await lstat(path.join(root, ".preview"))).mode & 0o777,
      0o700,
    );
    await chmod(path.join(root, ".preview/credentials.json"), 0o644);
    await assert.rejects(previewSecrets(root), /permissions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("preview secrets reject symlinks and do not overwrite unrelated files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusion-preview-test-"));
  try {
    await previewSecrets(root);
    const file = path.join(root, ".preview/credentials.json");
    await rm(file);
    await symlink(path.join(root, "missing"), file);
    await assert.rejects(privateFile(file), /permissions/);
    await assert.rejects(previewSecrets(root), /permissions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("host initializer generates a private DB secret once without writing credentials to output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fusion-preview-test-"));
  try {
    const script =
      "import importlib.util,pathlib,sys; spec=importlib.util.spec_from_file_location('preview_init','.devcontainer/initialize.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); m.initialize(pathlib.Path(sys.argv[1]))";
    assert.equal(
      execFileSync("python3", ["-c", script, root], {
        encoding: "utf8",
        timeout: 5000,
      }),
      "",
    );
    const file = path.join(root, ".preview/db-password");
    const first = await privateFile(file);
    execFileSync("python3", ["-c", script, root], { timeout: 5000 });
    assert.ok(first.length === 64 && first === (await privateFile(file)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("devcontainer forwards only 3000, disables automatic extra ports and opens credentials inside Codespace", async () => {
  const config = JSON.parse(
    await readFile(".devcontainer/devcontainer.json", "utf8"),
  );
  assert.deepEqual(config.forwardPorts, [3000]);
  assert.equal(config.otherPortsAttributes.onAutoForward, "ignore");
  assert.equal(
    config.customizations.vscode.settings["remote.autoForwardPorts"],
    false,
  );
  assert.deepEqual(config.customizations.codespaces.openFiles, [
    ".preview/login.txt",
  ]);
  const compose = await readFile(".devcontainer/compose.yaml", "utf8");
  assert.ok(!/^\s+ports:/m.test(compose));
  assert.ok(compose.includes("chromium-seccomp.json"));
  assert.ok(compose.includes("POSTGRES_PASSWORD_FILE"));
});

test("container shutdown signals only its identified preview supervisor and waits for graceful exit", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "fusion-preview-shutdown-"),
  );
  let child;
  try {
    await mkdir(path.join(root, ".preview"), { mode: 0o700 });
    await mkdir(path.join(root, ".devcontainer"));
    const script = path.join(root, ".devcontainer/serve.mjs");
    await privateWrite(
      script,
      "setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));console.log('ready');",
    );
    child = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
    await privateWrite(
      path.join(root, ".preview/supervisor.pid"),
      String(child.pid),
    );
    const exited = new Promise((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    await stopPreview(root, 5000);
    assert.equal(await exited, 0);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("stale or foreign PID files cannot signal unrelated processes", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "fusion-preview-shutdown-"),
  );
  try {
    await mkdir(path.join(root, ".preview"), { mode: 0o700 });
    await privateWrite(
      path.join(root, ".preview/supervisor.pid"),
      String(process.pid),
    );
    await stopPreview(root, 10);
    assert.equal(process.kill(process.pid, 0), true);
    await privateWrite(path.join(root, ".preview/supervisor.pid"), "-1");
    await stopPreview(root, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
