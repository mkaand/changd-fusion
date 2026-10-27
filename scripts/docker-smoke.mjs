// Only synthetic local fixtures. The container has no external network access.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = readFileSync(path.join(root, "server/Dockerfile"), "utf8").match(/^ARG CHROMIUM_VERSION=(\S+)$/m)?.[1];
if (!expectedVersion || !readFileSync(path.join(root, ".devcontainer/Dockerfile"), "utf8").includes(`ARG CHROMIUM_VERSION=${expectedVersion}\n`)) throw Error("Production and Dev Container Chromium pins must agree");
const script = String.raw`
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {capture} from './dist/capture.js';
import {previewRegion} from './dist/region-picker.js';
import {EgressPolicy} from './dist/egress.js';
import {readConfig} from './dist/config.js';
import {pngDimensions} from './dist/image.js';
assert.equal(process.getuid(),1000);
for(const pkg of ['chromium','chromium-common','chromium-sandbox'])assert.equal(execFileSync('dpkg-query',['-W','-f='+String.fromCharCode(36)+'{Version}',pkg],{encoding:'utf8'}),process.env.EXPECTED_CHROMIUM_VERSION);
console.log('Verified matching Debian browser/common/sandbox '+process.env.EXPECTED_CHROMIUM_VERSION+' on '+process.arch);
assert.equal((await readFile('/sys/fs/cgroup/memory.max','utf8')).trim(),'1073741824');
assert.equal((await readFile('/sys/fs/cgroup/pids.max','utf8')).trim(),'256');
assert.equal((await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),'100000 100000');
async function noBrowserProcesses(){
 for(let attempt=0;attempt<20;attempt++){
  const remaining=[];
  for(const pid of await readdir('/proc'))if(/^\d+$/.test(pid))try{const status=await readFile('/proc/'+pid+'/status','utf8');if(/^Name:\s+(?:chromium|chrome)/m.test(status))remaining.push(pid);}catch{}
  if(!remaining.length)return;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 throw Error('Browser processes remained after bounded cleanup');
}
const fixture=http.createServer((req,res)=>{if(req.url==='/stall')return;res.setHeader('Content-Type','text/html');res.end('<style>body{margin:0}main{width:320px;height:240px}footer{height:1800px}</style><button id="cookie" onclick="this.remove()">Consent</button><main id="preview-target">Docker hybrid fixture</main><footer></footer>');});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const port=fixture.address().port;
const cfg=readConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/fixture',JWT_SECRET:randomBytes(32).toString('hex'),CHANNEL_KEY:randomBytes(32).toString('hex'),PLAYWRIGHT_EXECUTABLE_PATH:'/usr/bin/chromium'});
const policy=new EgressPolicy(async()=>[{address:'127.0.0.1',family:4}],ip=>ip==='127.0.0.1',new Set([port]));
try {
 for(const [mode,selectorType] of [['viewport','css'],['full_page','css'],['element','css'],['element','xpath']]) {
  const result=await capture({url:'http://fixture.test:'+port,kind:'browser',text_enabled:true,visual_enabled:true,selector:'//main',selector_type:'xpath',ignore_selectors:[],mask_selectors:[],ignore_text:[],normalize_whitespace:true,ignore_case:false,capture_mode:mode,capture_selector:selectorType==='css'?'#preview-target':'//main',capture_selector_type:selectorType,browser_steps:[{action:'dismiss_cookie',selector:'#cookie'}]},cfg,policy);
  assert.equal(result.text,'Docker hybrid fixture');const dimensions=pngDimensions(result.screenshot);assert.equal(dimensions.width,mode==='element'?320:1280);assert.equal(dimensions.height,mode==='element'?240:mode==='full_page'?2040:900);
  await noBrowserProcesses();
 }
 const coordinateBrowser=await chromium.launch({executablePath:'/usr/bin/chromium',chromiumSandbox:true,timeout:15000});
 let point;
 try {
  const coordinateContext=await coordinateBrowser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:1});
  const coordinatePage=await coordinateContext.newPage();
  await coordinatePage.goto('http://127.0.0.1:'+port,{waitUntil:'domcontentloaded'});
  const targetBox=await coordinatePage.locator('#preview-target').boundingBox();
  assert.ok(targetBox);
  point={x:Math.round(targetBox.x+targetBox.width/2),y:Math.round(targetBox.y+targetBox.height/2)};
  await coordinateContext.close();
 } finally {await coordinateBrowser.close();}
 const preview=await previewRegion({id:'preview',url:'http://fixture.test:'+port,kind:'browser',text_enabled:false,visual_enabled:true,browser_steps:[]},cfg,point,policy);
 assert.equal(preview.selection.selector,'#preview-target');
 await noBrowserProcesses();
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',chromiumSandbox:true,timeout:15000});
 try {const page=await browser.newPage();await page.goto('chrome://sandbox');assert.match(await page.locator('body').innerText(),/Seccomp-BPF sandbox\s+Yes/);} finally {await browser.close();}
 await noBrowserProcesses();
 await assert.rejects(capture({url:'http://fixture.test:'+port+'/stall',kind:'browser',text_enabled:true,visual_enabled:true,browser_steps:[],ignore_selectors:[],mask_selectors:[],ignore_text:[],capture_mode:'viewport'}, {...cfg,CAPTURE_TIMEOUT_MS:1500},policy),error=>error.code==='timeout');
 await noBrowserProcesses();
 console.log('PASS: UID 1000, CPU/RAM/PID limits, Browser Steps, API region preview, CSS/XPath hybrid capture modes, Seccomp-BPF sandbox and cleanup after success/timeout');
} finally {const done=new Promise(resolve=>fixture.close(resolve));fixture.closeAllConnections();await done;}
`;
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "-i",
    "--init",
    "--network",
    "none",
    "--security-opt",
    "seccomp=" + path.join(root, "docker/chromium-seccomp.json"),
    "--cpus",
    "1",
    "--memory",
    "1g",
    "--pids-limit",
    "256",
    "--shm-size",
    "256m",
    ...(process.env.FUSION_DOCKER_DIST ? ["--mount", `type=bind,source=${path.resolve(process.env.FUSION_DOCKER_DIST)},target=/app/dist,readonly`] : []),
    "--env",
    "EXPECTED_CHROMIUM_VERSION=" + expectedVersion,
    process.env.FUSION_DOCKER_IMAGE ?? "changd-fusion-api:ci",
    "node",
    "--input-type=module",
  ],
  {
    input: script,
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 1024 * 1024,
    cwd: root,
  },
);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error("Docker smoke process failed or exceeded its deadline");
  process.exit(1);
}
process.exit(result.status ?? 1);
