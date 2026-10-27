// Synthetic concurrent resource measurement under unchanged Compose lane limits.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

const image = process.env.FUSION_DOCKER_IMAGE ?? "changd-fusion-api:ci";
const script = String.raw`
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {capture} from './dist/capture.js';
import {previewRegion,closeRegionPreviewSessions} from './dist/region-picker.js';
import {EgressPolicy} from './dist/egress.js';
import {readConfig} from './dist/config.js';
assert.equal(process.getuid(),1000);
const lane=process.env.TEST_LANE;
const started=Date.now();
const fixture=http.createServer((_req,res)=>res.end('<main id="target" style="width:320px;height:240px">Bounded resource fixture</main>'));
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const port=fixture.address().port;
const cfg=readConfig({NODE_ENV:'test',DATABASE_URL:'postgresql://localhost/fixture',JWT_SECRET:randomBytes(32).toString('hex'),CHANNEL_KEY:randomBytes(32).toString('hex'),PLAYWRIGHT_EXECUTABLE_PATH:'/usr/bin/chromium'});
const policy=new EgressPolicy(async()=>[{address:'127.0.0.1',family:4}],ip=>ip==='127.0.0.1',new Set([port]));
const monitor={url:'http://fixture.test:'+port,kind:'browser',text_enabled:false,visual_enabled:true,capture_mode:'viewport',ignore_selectors:[],mask_selectors:[],ignore_text:[],browser_steps:lane==='capture'?[{action:'delay',duration_ms:5000,timeout_ms:6000}]:[]};
let pids=0;
const sample=setInterval(()=>void readFile('/sys/fs/cgroup/pids.current','utf8').then(v=>{pids=Math.max(pids,Number(v));}),50);
try {
 if(lane==='preview'){
  const result=await previewRegion(monitor,cfg,undefined,policy,{ownerId:'resource-fixture',retain:true});
  assert.ok(result.session_id);assert.ok(result.image.length>100);
  await new Promise(resolve=>setTimeout(resolve,6000));
 }else{const result=await capture(monitor,cfg,policy);assert.ok(result.screenshot.length>100);}
 await closeRegionPreviewSessions();
 const memory=Number(await readFile('/sys/fs/cgroup/memory.peak','utf8'));
 const limit=Number(await readFile('/sys/fs/cgroup/memory.max','utf8'));
 assert.ok(memory<limit);assert.ok(pids<Number(await readFile('/sys/fs/cgroup/pids.max','utf8')));
 assert.match(await readFile('/sys/fs/cgroup/memory.events','utf8'),/oom_kill 0/);
 console.log(JSON.stringify({lane,started,finished:Date.now(),peakMemoryBytes:memory,peakPids:pids,cpu: (await readFile('/sys/fs/cgroup/cpu.stat','utf8')).trim()}));
}finally{clearInterval(sample);await closeRegionPreviewSessions();const closed=new Promise(resolve=>fixture.close(resolve));fixture.closeAllConnections();await closed;}
`;
function run(lane, cpu, memory, pids, shm) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["run", "--rm", "-i", "--init", "--network", "none", "--security-opt", `seccomp=${path.resolve("docker/chromium-seccomp.json")}`, "--cpus", cpu, "--memory", memory, "--pids-limit", pids, "--shm-size", shm, "--tmpfs", "/tmp:rw,nosuid,nodev,size=134217728,mode=1777", "-e", `TEST_LANE=${lane}`, image, "node", "--input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); if (code) reject(Error(stderr || `Docker exited ${code}`)); else resolve(JSON.parse(stdout.trim())); });
    child.stdin.end(script);
  });
}
const results = await Promise.all([run("preview", "0.75", "640m", "192", "64m"), run("capture", "1", "1g", "256", "256m")]);
assert.ok(Math.min(...results.map(r => r.finished)) > Math.max(...results.map(r => r.started)) + 3000, "lanes ran concurrently");
for (const result of results) console.log(JSON.stringify(result));
console.log("PASS: simultaneous rootless Preview/Worker fit existing CPU, RAM, PID and SHM limits");
