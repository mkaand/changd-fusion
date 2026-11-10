import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EgressPolicy } from "../server/dist/egress.js";
import { fetchFileMetadata, serializeFileMetadata } from "../server/dist/file-monitor.js";
import { capture } from "../server/dist/capture.js";
import { monitorInput } from "../server/dist/monitor-schema.js";
import { openSimpleDatabase, saveMonitor, getMonitor } from "./db.mjs";
import { FusionEngine } from "./engine.mjs";

async function fixture(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://public.example:${port}/file.pdf`;
  const base = new EgressPolicy(async () => [{address:"127.0.0.1",family:4}], () => true, new Set([port]));
  const policy = { target: input => base.target(input) };
  try { await run({url, requests, policy, port}); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test("HEAD metadata, conditional 304, and deterministic representation", async () => {
  await fixture((req,res) => {
    if(req.headers["if-none-match"] === '"v1"') { res.writeHead(304); res.end(); return; }
    res.writeHead(200,{ETag:'"v1"',"Last-Modified":"Mon, 01 Jan 2024 00:00:00 GMT","Content-Length":"42"}); res.end();
  }, async ({url,requests,policy}) => {
    const first=await fetchFileMetadata(url,policy);
    assert.deepEqual(first,{etag:'"v1"',last_modified:"Mon, 01 Jan 2024 00:00:00 GMT",size:42,status:200});
    assert.deepEqual(await fetchFileMetadata(url,policy,first),first);
    assert.equal(requests[1].headers["if-none-match"],'"v1"');
    assert.equal(requests[1].headers["if-modified-since"],first.last_modified);
    assert.equal(requests.every(r=>r.method==="HEAD"),true);
    assert.equal(serializeFileMetadata(first),serializeFileMetadata(first));
  });
});

test("capture and API schema accept File Monitor without a browser",async()=>{
  await fixture((_req,res)=>{res.writeHead(200,{ETag:'"file"',"Content-Length":"18"});res.end();},async({url,policy})=>{
    const config=monitorInput.parse({name:"File",url,kind:"file",text_enabled:true,visual_enabled:false});
    assert.equal(config.kind,"file");
    assert.equal(monitorInput.safeParse({...config,text_source:"jina"}).success,false);
    const result=await capture({...config,id:randomUUID(),user_id:randomUUID()}, {CAPTURE_TIMEOUT_MS:1000},policy);
    assert.equal(JSON.parse(result.text).size,18);
    assert.equal(result.http_status,200);
    assert.equal(result.screenshot,null);
  });
});

test("ETag, Last-Modified and size each trigger a distinct metadata difference",async()=>{
  let etag='"one"',lastModified="Mon, 01 Jan 2024 00:00:00 GMT",size=10;
  await fixture((_req,res)=>{res.writeHead(200,{ETag:etag,"Last-Modified":lastModified,"Content-Length":String(size)});res.end();},async({url,policy})=>{
    let previous=await fetchFileMetadata(url,policy);
    for(const change of [()=>etag='"two"',()=>lastModified="Tue, 02 Jan 2024 00:00:00 GMT",()=>size=11]){
      change();const next=await fetchFileMetadata(url,policy);
      assert.notEqual(serializeFileMetadata(previous),serializeFileMetadata(next));previous=next;
    }
  });
});

test("redirects revalidate each destination before connecting",async()=>{
  await fixture((req,res)=>{
    if(req.url==="/file.pdf"){res.writeHead(302,{Location:"/next"});res.end();return;}
    res.writeHead(200,{ETag:'"next"',"Content-Length":"7"});res.end();
  },async({url,policy,requests})=>{
    const calls=[];
    const validating={target:async input=>{calls.push(input);return policy.target(input);}};
    assert.equal((await fetchFileMetadata(url,validating)).size,7);
    assert.deepEqual(calls,[url,new URL("/next",url).href]);
    assert.deepEqual(requests.map(r=>r.path),["/file.pdf","/next"]);
  });
  await assert.rejects(new EgressPolicy().target("http://127.0.0.1/file"),/Private destinations/);
});

for(const unsupported of [405,501]) test(`HEAD ${unsupported} falls back to Range 206 and parses total size`,async()=>{
  await fixture((req,res)=>{
    if(req.method==="HEAD") {res.writeHead(unsupported);res.end();return;}
    res.writeHead(206,{"Content-Range":"bytes 0-0/987654321", "Content-Length":"1",ETag:'"range"'});res.end("x");
  },async({url,requests,policy})=>{
    const found=await fetchFileMetadata(url,policy);
    assert.equal(found.size,987654321);assert.equal(found.etag,'"range"');assert.equal(found.status,206);
    assert.deepEqual(requests.map(r=>r.method),["HEAD","GET"]);
    assert.equal(requests[1].headers.range,"bytes=0-0");
  });
});

test("HEAD lacking size uses Range and ignores a large 200 body",async()=>{
  let sent=0,closed=false;
  await fixture((req,res)=>{
    if(req.method==="HEAD"){res.writeHead(200,{ETag:'"first"'});res.end();return;}
    res.on("close",()=>{closed=true;});
    res.writeHead(200,{"Content-Length":"100000000",ETag:'"second"'});
    const interval=setInterval(()=>{if(res.destroyed){clearInterval(interval);return;}sent+=65536;res.write(Buffer.alloc(65536));},1);
    interval.unref();
  },async({url,policy,requests})=>{
    const found=await fetchFileMetadata(url,policy);
    assert.equal(found.size,100000000);assert.equal(found.status,200);
    assert.equal(requests[1].headers.range,"bytes=0-0");
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(closed,true);assert.ok(sent<100000000);
  });
});

test("missing metadata, HTTP failure, timeout, and unsafe redirects fail",async()=>{
  await fixture((req,res)=>{res.writeHead(req.method==="HEAD"?200:206);res.end();},async({url,policy})=>{
    await assert.rejects(fetchFileMetadata(url,policy),/metadata unavailable/);
  });
  await fixture((_req,res)=>{res.writeHead(503);res.end();},async({url,policy})=>{
    await assert.rejects(fetchFileMetadata(url,policy),/HTTP 503/);
  });
  await fixture((_req,res)=>setTimeout(()=>res.end(),100),async({url,policy})=>{
    await assert.rejects(fetchFileMetadata(url,policy,null,10),/timed out/);
  });
  await fixture((_req,res)=>{res.writeHead(302,{Location:"http://127.0.0.1/private"});res.end();},async({url,policy})=>{
    const guarded={target:input=>new URL(input).hostname==="public.example"?policy.target(input):new EgressPolicy().target(input)};
    await assert.rejects(fetchFileMetadata(url,guarded),/Private destinations/);
  });
});

test("File Monitor SQLite, scheduled and Check Now comparisons, notifications, failure baseline",async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"file-monitor-")); let db,engine;
  try {
    db=openSimpleDatabase(path.join(dir,"fusion.sqlite"));
    const user=randomUUID(),id=randomUUID(),channel=randomUUID();
    db.prepare("INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)").run(user,"file@example.com","hash","{}");
    const monitor={id,user_id:user,name:"File",url:"https://example.com/file.zip",kind:"file",text_enabled:true,visual_enabled:false,
      enabled:true,paused:false,notification_enabled:true,normalize_whitespace:true,ignore_text:[],ignore_case:false,interval_seconds:30,next_run:new Date(Date.now()-1000).toISOString()};
    saveMonitor(db,monitor,user);
    assert.equal(getMonitor(db,id,user).kind,"file");
    saveMonitor(db,{...getMonitor(db,id,user),name:"Updated file"},user,{replace:true});
    assert.equal(getMonitor(db,id,user).name,"Updated file");
    db.prepare("INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)").run(channel,user,JSON.stringify({id:channel,user_id:user,name:"Telegram",provider:"telegram",enabled:true}));
    db.prepare("INSERT INTO monitor_channels(monitor_id,channel_id) VALUES(?,?)").run(id,channel);
    const values=[
      {etag:'"one"',last_modified:"Mon, 01 Jan 2024 00:00:00 GMT",size:10,status:200},
      {etag:'"two"',last_modified:"Tue, 02 Jan 2024 00:00:00 GMT",size:11,status:200},
      null,
      {etag:'"two"',last_modified:"Tue, 02 Jan 2024 00:00:00 GMT",size:11,status:200},
    ];
    const calls=[];
    const browser={status:{preview:false},capture:async m=>{
      calls.push(m.file_baseline);
      const value=values.shift();
      return value?{ok:true,text:serializeFileMetadata(value),screenshot:null,http_status:value.status}:{ok:false,code:"file_metadata_unavailable"};
    },close(){}};
    engine=new FusionEngine(db,{dataDir:dir,channelKey:"a".repeat(64),browser,sendNotification:async()=>{}});
    await engine.tick();
    let current=getMonitor(db,id,user);const first=current.baseline_id;
    assert.equal(current.file_metadata.size,10);assert.equal(calls[0],null);
    db.prepare("UPDATE monitors SET next_run=? WHERE id=?").run(Date.now()-1,id);
    await engine.tick();
    current=getMonitor(db,id,user);const second=current.baseline_id;
    assert.notEqual(first,second);assert.equal(JSON.parse(calls[1]).etag,'"one"');
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE status='changed'").get().n,1);
    assert.equal(db.prepare("SELECT count(*) n FROM outbox").get().n,1);
    const changed=JSON.parse(db.prepare("SELECT payload FROM events WHERE status='changed'").get().payload);
    assert.equal(changed.source_kind,"file");assert.match(JSON.stringify(changed.text_diff),/last_modified|size|etag/);
    db.prepare("UPDATE monitors SET next_run=? WHERE id=?").run(Date.now()-1,id);
    await engine.tick();
    current=getMonitor(db,id,user);assert.equal(current.baseline_id,second);assert.equal(current.file_metadata.size,11);
    const run=engine.enqueue(id,user);await engine.tick();
    current=getMonitor(db,id,user);
    assert.equal(engine.manualFor(id,user).status,"completed");assert.equal(current.failure_count,0);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE status='unchanged'").get().n,1);
  } finally {engine?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});
