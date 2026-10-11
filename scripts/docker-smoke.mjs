// Only synthetic local fixtures. The container has no external network access.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = String.raw`
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {capture} from './dist/capture.js';
import {previewRegion} from './dist/region-picker.js';
import {EgressPolicy} from './dist/egress.js';
import {readConfig} from './dist/config.js';
import {pngDimensions} from './dist/image.js';
assert.equal(process.getuid(),1000);
assert.equal((await readFile('/sys/fs/cgroup/memory.max','utf8')).trim(),'1073741824');
assert.equal((await readFile('/sys/fs/cgroup/pids.max','utf8')).trim(),'256');
assert.equal((await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),'100000 100000');
const fixture=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<style>body{margin:0}main{width:320px;height:240px}footer{height:1800px}</style><button id="cookie" onclick="this.remove()">Consent</button><main id="preview-target">Docker hybrid fixture</main><footer></footer>');});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const port=fixture.address().port;
const cfg=readConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/fixture',JWT_SECRET:randomBytes(32).toString('hex'),CHANNEL_KEY:randomBytes(32).toString('hex'),PLAYWRIGHT_EXECUTABLE_PATH:'/usr/bin/chromium'});
const policy=new EgressPolicy(async()=>[{address:'127.0.0.1',family:4}],ip=>ip==='127.0.0.1',new Set([port]));
try {
 for(const mode of ['viewport','full_page','element']) {
  const result=await capture({url:'http://fixture.test:'+port,kind:'browser',text_enabled:true,visual_enabled:true,selector:'//main',selector_type:'xpath',ignore_selectors:[],mask_selectors:[],ignore_text:[],normalize_whitespace:true,ignore_case:false,capture_mode:mode,capture_selector:'//main',capture_selector_type:'xpath',browser_steps:[{action:'dismiss_cookie',selector:'#cookie'}]},cfg,policy);
  assert.equal(result.text,'Docker hybrid fixture');assert.equal(pngDimensions(result.screenshot).width,mode==='element'?320:1280);
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
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',chromiumSandbox:true,timeout:15000});
 try {const page=await browser.newPage();await page.goto('chrome://sandbox');assert.match(await page.locator('body').innerText(),/Seccomp-BPF sandbox\s+Yes/);} finally {await browser.close();}
 console.log('PASS: UID 1000, CPU/RAM/PID limits, Browser Steps, API region preview, CSS/XPath hybrid capture modes and Seccomp-BPF sandbox');
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
