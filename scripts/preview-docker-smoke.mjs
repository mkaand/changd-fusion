import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const dockerfile = readFileSync(".devcontainer/Dockerfile", "utf8");
if (dockerfile.includes("ARG CHROMIUM_VERSION=") || !dockerfile.includes("dpkg-query -W -f='${Version}' chromium"))
  throw Error("Dev Container must resolve and verify matching Chromium packages from Debian metadata");
// Reuse the checked-in application browser dependency through a read-only bind, never copy private runtime state.
const script = `
const {chromium}=require('/source/server/node_modules/playwright');
const {execFileSync}=require('node:child_process');
(async()=>{
 if(process.getuid()!==1000)throw Error('UID 1000 browser required');
 const versions=Object.fromEntries(['chromium','chromium-common','chromium-sandbox'].map(pkg=>[pkg,execFileSync('dpkg-query',['-W','-f='+String.fromCharCode(36)+'{Version}',pkg],{encoding:'utf8'})]));
 if(new Set(Object.values(versions)).size!==1)throw Error('Chromium package version mismatch');
 const manifest=Object.fromEntries(require('node:fs').readFileSync('/usr/local/share/changd-fusion/chromium-version','utf8').trim().split('\\n').map(line=>line.split(/=(.*)/s)));
 for(const [pkg,version] of Object.entries(versions))if(manifest[pkg]!==version)throw Error('Chromium version manifest mismatch');
 if(!/Chromium/i.test(execFileSync('/usr/bin/chromium',['--version'],{encoding:'utf8'})))throw Error('Chromium executable version missing');
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',chromiumSandbox:true,timeout:15000});
 try{const page=await browser.newPage();await page.goto('chrome://sandbox');if(!/Seccomp-BPF sandbox\\s+Yes/.test(await page.locator('body').innerText()))throw Error('Sandbox inactive');}
 finally{await browser.close();}
 console.log('PASS: Codespaces image rootless Chromium sandbox');
})().catch(()=>process.exit(1));`;
const r = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--security-opt",
    `seccomp=${process.cwd()}/docker/chromium-seccomp.json`,
    "--cpus",
    "2",
    "--memory",
    "1g",
    "--pids-limit",
    "256",
    "--shm-size",
    "256m",
    "-v",
    `${process.cwd()}/server/node_modules:/source/server/node_modules:ro`,
    process.env.FUSION_PREVIEW_IMAGE ?? "changd-fusion-preview:ci",
    "node",
    "-e",
    script,
  ],
  { encoding: "utf8", timeout: 45000, maxBuffer: 100000 },
);
if (r.stdout) process.stdout.write(r.stdout);
if (r.error || r.status !== 0) {
  console.error(
    "Codespaces image sandbox smoke failed within its finite deadline",
  );
  process.exit(1);
}
