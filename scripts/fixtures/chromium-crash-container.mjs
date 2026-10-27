// Disposable-container lifecycle fixture. No external URLs or production data.
import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { makePool } from "/app/dist/db.js";
import { migrate } from "/app/dist/migrate.js";
import { enqueueManualRun } from "/app/dist/chromium-capacity.js";

const pool = makePool(process.env.DATABASE_URL);
assert.equal(process.getuid(), 1000, "crash fixtures must retain rootless production execution");
await migrate(pool);
const state = { ready: false, aborted: false, result: null, actorPid: null, actorExit: null, waiterResult: null, peakRoots: 0 };
const fixture = http.createServer((req, res) => {
  if (req.url === "/stall" || mode === "manual-crash") { state.ready = true; return; }
  res.end("<!doctype html><main>Crash recovery fixture</main>");
});
await new Promise(resolve => fixture.listen(8123, "127.0.0.1", resolve));
const mode = process.env.CRASH_MODE;
const owner = (await pool.query("INSERT INTO users(email,password,firstname,lastname,user_type) VALUES($1,'synthetic-hash','Crash','Fixture',0) RETURNING user_id", [`${randomBytes(8).toString("hex")}@example.com`])).rows[0].user_id;
await pool.query("UPDATE fusion_monitors m SET enabled=false WHERE NOT EXISTS(SELECT 1 FROM fusion_manual_runs r WHERE r.monitor_id=m.id AND r.status IN ('queued','running'))");
let monitorId;
if (["capture", "handoff", "watchdog", "manual-crash"].includes(mode)) {
  monitorId = (await pool.query("INSERT INTO fusion_monitors(user_id,name,url,kind,text_enabled,visual_enabled,interval_seconds,next_run) VALUES($1,'Crash fixture',$2,'browser',true,true,60,now()) RETURNING id", [owner, `http://crash.fixture:8123/${["watchdog", "manual-crash"].includes(mode) ? "document" : "stall"}`])).rows[0].id;
  if (mode === "manual-crash") await enqueueManualRun(pool, owner, monitorId, true);
}

const actorScript = String.raw`
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {makePool} from './dist/db.js';
import {readConfig} from './dist/config.js';
import {capture} from './dist/capture.js';
import {workerCycle} from './dist/worker.js';
import {previewRegion} from './dist/region-picker.js';
import {EgressPolicy} from './dist/egress.js';
import {acquireChromiumLease,createInteractivePriorityIntent} from './dist/chromium-capacity.js';
const pool=makePool(process.env.DATABASE_URL), mode=process.env.ACTOR_MODE;
const cfg=readConfig({NODE_ENV:'test',DATABASE_URL:process.env.DATABASE_URL,JWT_SECRET:randomBytes(32).toString('hex'),CHANNEL_KEY:randomBytes(32).toString('hex'),DATA_DIR:'/tmp/crash-artifacts',PLAYWRIGHT_EXECUTABLE_PATH:'/usr/bin/chromium'});
const policy=new EgressPolicy(async()=>[{address:'127.0.0.1',family:4}],ip=>ip==='127.0.0.1',new Set([8123]));
const send=value=>console.log(JSON.stringify(value));
if(mode==='watchdog'||mode==='handoff'){
 const launch=chromium.launch.bind(chromium);
 chromium.launch=async options=>{const browser=await launch(options);browser.close=()=>new Promise(()=>{});return browser;};
}
if(['capture','handoff','watchdog','manual-crash','resume'].includes(mode)){
 let stopped=false;
 await workerCycle(pool,cfg,{stopped:()=>stopped,capture:async(m,c,unused,signal)=>{
  signal?.addEventListener('abort',()=>send({aborted:true}),{once:true});
  try{return await capture(m,c,policy,signal);}finally{stopped=true;}
 }}).then(()=>send({ready:true,result:'completed'}),e=>send({ready:true,result:e.name,resource:e.resource}));
}else{
 const intent=mode==='waiter'?await createInteractivePriorityIntent(pool,process.env.OWNER_ID,'preview'):undefined;
 const lease=await acquireChromiumLease(pool,{workload:'preview',slots:1,waitMs:mode==='waiter'?5000:0,priorityIntentId:intent});
 if(!lease)throw Error('Fixture admission unavailable');
 lease.signal.addEventListener('abort',()=>send({aborted:true}),{once:true});
 if(mode==='orphan'){
  const browser=spawn('/usr/bin/chromium',['--headless','--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1','--no-first-run','--user-data-dir=/tmp/orphan-browser','http://127.0.0.1:8123/document'],{detached:true,stdio:'ignore'});
  browser.unref();
  let ready=false;
  for(let i=0;i<100;i++){try{const response=await fetch('http://127.0.0.1:9222/json/version');if(response.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  if(!ready)throw Error('Orphan fixture browser did not start');
  send({ready:true});
 }else{
  await previewRegion({id:'crash-preview',url:'http://crash.fixture:8123/document',kind:'browser',visual_enabled:true,text_enabled:false,browser_steps:[]},cfg,undefined,policy,{ownerId:process.env.OWNER_ID,retain:true,acquireCapacity:async()=>lease});
  send({ready:true});
 }
}
setInterval(()=>{},1000);
`;
function startActor(actorMode, waiter = false) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", actorScript], { env: { ...process.env, ACTOR_MODE: actorMode, OWNER_ID: owner }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.pipe(process.stderr);
  if (!waiter) state.actorPid = child.pid;
  let pending = "";
  child.stdout.on("data", data => {
    pending += data;
    const lines = pending.split("\n"); pending = lines.pop();
    for (const line of lines) try {
      const value = JSON.parse(line);
      if (waiter) state.waiterResult = value;
      else Object.assign(state, value);
    } catch { /* Only structured synthetic fixture diagnostics are collected. */ }
  });
  child.on("exit", (code, signal) => {
    if (waiter && !state.waiterResult) state.waiterResult = { exited: true, code, signal };
    if (!waiter) state.actorExit = { code, signal };
  });
  return child;
}
const actor = startActor(mode);
async function browserRoots() {
  const roots = [];
  for (const pid of await readdir("/proc")) if (/^\d+$/.test(pid)) try {
    const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
    if (/\/(?:chromium|chrome)$/.test(command.split("\0")[0]) && (command.includes("--remote-debugging-pipe") || command.includes("--remote-debugging-port=9222")) && !command.includes("--type=")) {
      if (command.includes("--no-sandbox")) throw Error("Sandbox disabled in crash fixture");
      roots.push(Number(pid));
    }
  } catch (error) { if (error.message === "Sandbox disabled in crash fixture") throw error; }
  state.peakRoots = Math.max(state.peakRoots, roots.length);
  return roots;
}
let sampling = false;
setInterval(() => {
  if (sampling) return;
  sampling = true;
  void browserRoots().finally(() => { sampling = false; });
}, 50);
const control = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/kill") {
      await new Promise(resolve => { actor.once("exit", resolve); actor.kill("SIGKILL"); });
    }
    if (req.method === "POST" && req.url === "/waiter") startActor("waiter", true);
    const roots = await browserRoots();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ...state, roots, monitorId }));
  } catch { res.statusCode = 500; res.end("Fixture control failure"); }
});
await new Promise(resolve => control.listen(8033, "127.0.0.1", resolve));
