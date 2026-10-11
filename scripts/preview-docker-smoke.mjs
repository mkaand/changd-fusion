import { spawnSync } from "node:child_process";
// Reuse the checked-in application browser dependency through a read-only bind, never copy private runtime state.
const script = `
const {chromium}=require('/source/server/node_modules/playwright');
(async()=>{
 if(process.getuid()===0)throw Error('Rootless browser required');
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
