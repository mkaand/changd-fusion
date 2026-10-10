// Real Dev Containers CLI lifecycle. No mocked HOME, UID, PostgreSQL or VS Code setup.
// This is not a Codespaces gateway: fail-closed port verification is tested separately.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
const root = process.cwd();
const temp = mkdtempSync(
  path.join(os.tmpdir(), "fusion-devcontainer-recovery-"),
);
const workspace = path.join(temp, "fusion-recovery-" + process.pid);
const image = process.env.FUSION_PREVIEW_IMAGE ?? "changd-fusion-preview:ci";
const cli = process.env.DEVCONTAINER_CLI ?? "devcontainer";
let project = path.basename(workspace) + "_devcontainer";
function command(cmd, args, timeout = 30_000) {
  const r = spawnSync(cmd, args, {
    cwd: workspace,
    encoding: "utf8",
    timeout,
    maxBuffer: 2_000_000,
  });
  if (r.error || r.status !== 0)
    throw Error(
      `${cmd} failed: ${[r.stdout, r.stderr, r.error?.message].filter(Boolean).join("\n")}`,
    );
  return r.stdout;
}
try {
  mkdirSync(workspace);
  for (const file of execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")) {
    mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    cpSync(path.join(root, file), path.join(workspace, file));
  }
  // git ls-files does not include new files before commit, but development runs must test them.
  cpSync(
    path.join(root, ".devcontainer"),
    path.join(workspace, ".devcontainer"),
    { recursive: true },
  );
  cpSync(
    path.join(root, "scripts/devcontainer-app-smoke.mjs"),
    path.join(workspace, "scripts/devcontainer-app-smoke.mjs"),
  );
  command("python3", [".devcontainer/initialize.py"]);
  const secretHash = createHash("sha256")
    .update(readFileSync(path.join(workspace, ".preview/db-password")))
    .digest("hex");
  mkdirSync(path.join(workspace, "host-home"));
  const override = path.join(workspace, ".devcontainer/lifecycle-test.yaml");
  writeFileSync(
    override,
    `services:\n  permissions:\n    image: ${image}\n    build: !reset null\n  preview:\n    image: ${image}\n    build: !reset null\n    volumes:\n      - ../host-home:/home:ro\n`,
  );
  const cfg = JSON.parse(
    readFileSync(path.join(workspace, ".devcontainer/devcontainer.json")),
  );
  cfg.dockerComposeFile = [
    "compose.yaml",
    "lifecycle-test.yaml",
    ...(process.env.FUSION_LIFECYCLE_COMPOSE
      ? [path.resolve(process.env.FUSION_LIFECYCLE_COMPOSE)]
      : []),
  ];
  cfg.postStartCommand = "node .devcontainer/validate.mjs";
  cfg.initializeCommand = "python3 .devcontainer/initialize.py";
  // No real Codespaces context/token exists on CI. Do not simulate a private gateway.
  const config = path.join(workspace, ".devcontainer/devcontainer.json");
  writeFileSync(config, JSON.stringify(cfg));
  // Simulate a host-created runtime belonging to a different UID. No other paths touched.
  command("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0:0",
    "-v",
    `${temp}:/fixture`,
    image,
    "sh",
    "-c",
    `chown -R 1000:1000 /fixture/${path.basename(workspace)}; chown -R 2000:2000 /fixture/${path.basename(workspace)}/.preview; chown 0:0 /fixture/${path.basename(workspace)}/host-home; chmod 0755 /fixture/${path.basename(workspace)}/host-home`,
  ]);
  const oldHome = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "1000:1000",
      "-v",
      `${workspace}/host-home:/home`,
      image,
      "node",
      "-e",
      "require('fs').mkdirSync('/home/node')",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (oldHome.status === 0 || !oldHome.stderr.includes("EACCES"))
    throw Error("Missing HOME regression was not reproduced");
  console.log(
    "PASS: original missing /home/node permission error reproduced under a host home mount",
  );
  // Docker needs an existing child mountpoint when the test parent bind is read-only.
  command("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "0:0",
    "-v",
    `${workspace}/host-home:/fixture`,
    image,
    "mkdir",
    "-m",
    "0755",
    "/fixture/node",
  ]);
  // Parent temp directory remains owned by the test runner; the checkout mount is UID 1000.
  const args = [
    "up",
    "--workspace-folder",
    workspace,
    "--config",
    config,
    "--log-level",
    "debug",
  ];
  const output = command(cli, args, 480_000);
  const result = JSON.parse(output.trim().split("\n").at(-1));
  if (result.outcome !== "success")
    throw Error("Dev Container lifecycle failed");
  project = command("docker", [
    "inspect",
    result.containerId,
    "--format",
    '{{index .Config.Labels "com.docker.compose.project"}}',
  ]).trim();
  if (project !== path.basename(workspace) + "_devcontainer")
    throw Error("Unexpected lifecycle test project");
  const checks = `import {readFile,stat,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
    assert.equal(process.getuid(),1000);assert.equal(process.env.HOME,'/home/node');
    for(const d of ['/home/node','/home/node/.config/vscode-dev-containers','/home/node/.vscode-server','.preview']){const s=await stat(d);assert.equal(s.uid,1000);assert.equal(s.mode&511,448);}
    await writeFile('/home/node/.config/vscode-dev-containers/first-run-notice-already-displayed','');
    const secret=await readFile('.preview/db-password','utf8');if(!/^[a-f0-9]{64}$/.test(secret))throw Error('Invalid test secret');assert.equal((await import('node:crypto')).createHash('sha256').update(secret).digest('hex'),${JSON.stringify(secretHash)});
    const {default:pg}=await import('./server/node_modules/pg/lib/index.js');const p=new pg.Pool({connectionString:'postgresql://fusion_preview:'+secret+'@db:5432/fusion_preview'});
    try{const {migrate}=await import('./server/dist/migrate.js');await migrate(p);assert.equal((await p.query('SELECT count(*)::int AS count FROM fusion_migrations')).rows[0].count,3);}finally{await p.end();}
    console.log('PASS: real Dev Containers creation, npm/build lifecycle, HOME/VS Code writes, cross-UID private secret and PostgreSQL migrations');`;
  process.stdout.write(
    command("docker", [
      "exec",
      result.containerId,
      "node",
      "--input-type=module",
      "-e",
      checks,
    ]),
  );
  const denied = spawnSync(
    "docker",
    ["exec", result.containerId, "node", ".devcontainer/start.mjs"],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (denied.status === 0)
    throw Error(
      "Preview must refuse startup without actual Codespaces context",
    );
  console.log(
    "PASS: no preview startup without verified Codespaces context; secure gateway remains fail-closed",
  );
  process.stdout.write(
    command(
      "docker",
      [
        "exec",
        result.containerId,
        "node",
        "scripts/devcontainer-app-smoke.mjs",
      ],
      90_000,
    ),
  );
  // Resume must keep secret and DB; never run down --volumes on users' projects.
  command(cli, args, 120_000);
  console.log("PASS: Dev Containers lifecycle repeat/resume");
} finally {
  if (!project) {
    const candidates = spawnSync(
      "docker",
      ["ps", "-aq", "--filter", `label=devcontainer.local_folder=${workspace}`],
      { encoding: "utf8" },
    )
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    if (candidates[0])
      project = execFileSync(
        "docker",
        [
          "inspect",
          candidates[0],
          "--format",
          '{{index .Config.Labels "com.docker.compose.project"}}',
        ],
        { encoding: "utf8" },
      ).trim();
  }
  if (project === path.basename(workspace) + "_devcontainer")
    spawnSync(
      "docker",
      [
        "compose",
        "--project-name",
        project,
        "-f",
        path.join(workspace, ".devcontainer/compose.yaml"),
        "-f",
        path.join(workspace, ".devcontainer/lifecycle-test.yaml"),
        "down",
        "--volumes",
      ],
      { timeout: 90_000, stdio: "pipe" },
    );
  // Only this disposable test workspace and its own volumes are deleted.
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0:0",
      "-v",
      `${temp}:/fixture`,
      image,
      "sh",
      "-c",
      `chown -R ${process.getuid()}:${process.getgid()} /fixture/${path.basename(workspace)}`,
    ],
    { timeout: 30_000, stdio: "pipe" },
  );
  rmSync(temp, { recursive: true, force: true });
}
