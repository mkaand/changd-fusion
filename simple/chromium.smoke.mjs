// Real sandboxed Chromium acceptance smoke. Runs inside the built Simple image.
// Uses a public, non-private HTTPS page so SSRF policy remains enforced.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import http from "node:http";
import {createRequire} from "node:module";
import {BrowserQueue} from "./browser-queue.mjs";
import {previewRegion,releaseRegionPreviewSession} from "../server/dist/region-picker.js";
import {EgressPolicy} from "../server/dist/egress.js";
import {capture} from "../server/dist/capture.js";
import {segmentSelectedText,generateSelectedTextRule} from "../server/dist/selected-text.js";
const {PNG}=createRequire(new URL("../server/dist/capture.js",import.meta.url))("pngjs");

const page="https://example.com/";
const monitor={
  id:randomUUID(),user_id:randomUUID(),name:"Real browser smoke",
  url:page,kind:"browser",text_enabled:true,visual_enabled:true,
  selector:"",selector_type:"css",ignore_selectors:[],mask_selectors:[],ignore_text:[],
  normalize_whitespace:true,ignore_case:false,capture_mode:"viewport",
  capture_selector:"",capture_selector_type:"css",capture_area:null,
  browser_steps:[],
  step_budget_ms:15000,capture_timeout_ms:45000,monitor_http_error_pages:false,
  disable_javascript:true,block_ads_trackers:false,cookie_banner_handling:false,
  wait_before_capture_ms:0,mobile_view:false,visual_threshold:"0.35",pixel_threshold:"0.1",
  interval_seconds:300,baseline_id:null,latest_capture_id:null,failure_count:0
};
const limits={
  NODE_ENV:"production",DATABASE_URL:"unused",JWT_SECRET:"unused",CHANNEL_KEY:"unused",PORT:3000,
  PUBLIC_URL:"http://localhost:8127",DATA_DIR:"/data",REGISTRATION_ENABLED:"false",
  HISTORY_DAYS:90,CAPTURE_TIMEOUT_MS:45000,CHROMIUM_CONCURRENCY:1,
  PREVIEW_CAPACITY_WAIT_MS:12000,MAX_CAPTURE_WIDTH:4096,MAX_CAPTURE_HEIGHT:8192,
  MAX_CAPTURE_PIXELS:8000000,PLAYWRIGHT_EXECUTABLE_PATH:"/usr/bin/chromium",LOG_LEVEL:"warn"
};

test("real Chromium captures with JavaScript disabled, selected element and selected area", {timeout:180000},async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"fusion-chromium-smoke-")),queue=new BrowserQueue();
  try {
    for(const variant of [
      {capture_mode:"viewport",capture_selector:"",capture_area:null},
      {capture_mode:"viewport",capture_selector:"",capture_area:null,disable_javascript:false,
        browser_steps:[{action:"wait_selector",selector:"body",selector_type:"css",timeout_ms:10000,continue_on_error:false}]},
      {capture_mode:"element",capture_selector:"body",capture_area:null,disable_javascript:false},
      {capture_mode:"selected_area",capture_selector:"",capture_area:{x:20,y:20,width:220,height:120}}
    ]){
      const result=await queue.capture({...monitor,...variant},root,limits);
      assert.equal(result.ok,true,JSON.stringify({variant,result}));
      assert.ok(result.text?.length>0,"Browser must extract actual page text");
      assert.ok(result.screenshot,"Visual capture must include PNG file");
      const png=PNG.sync.read(readFileSync(path.join(root,"artifacts",result.screenshot)));
      assert.ok(png.width>0&&png.height>0);
      if(variant.capture_mode==="selected_area")assert.deepEqual([png.width,png.height],[220,120]);
    }
  }finally{queue.close();rmSync(root,{recursive:true,force:true});}
});
test("real interactive Preview reuses one slot, supports disabled JS and scrolling", {timeout:90000},async()=>{
  const queue=new BrowserQueue(),ownerId=randomUUID();
  try {
    const result=await previewRegion({...monitor,mobile_view:false},limits,undefined,new EgressPolicy(),{
      ownerId,retain:true,acquireCapacity:async(_onWait,waitMs)=>queue.acquirePreview({waitMs})
    });
    assert.ok(result.session_id&&result.image,"Preview must return retained screenshot");
    assert.ok(result.width>0&&result.height>0);
    assert.equal(queue.status.preview,true,"Retained preview owns Chromium slot");
    const scrolled=await previewRegion({...monitor,mobile_view:false},limits,undefined,new EgressPolicy(),{
      ownerId,id:result.session_id,retain:true,scrollDeltaY:150
    });
    assert.equal(scrolled.reused,true);
    assert.ok(Number.isFinite(scrolled.scroll_y));
    await releaseRegionPreviewSession(ownerId,result.session_id);
    assert.equal(queue.status.preview,false,"Preview must release capacity after browser cleanup");
  }finally{queue.close();}
});

test("a failing real Chromium step releases its slot for the next monitor", {timeout:90000},async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"fusion-chromium-recovery-")),queue=new BrowserQueue();
  try{
    const broken=await queue.capture({...monitor,disable_javascript:false,
      browser_steps:[{action:"wait_selector",selector:"#changd-fixture-absent",selector_type:"css",timeout_ms:1500,continue_on_error:false}]},root,limits);
    assert.equal(broken.ok,false,"Absent element should fail this monitor only");
    assert.equal(queue.status.capture,false,"Failed subprocess must release browser capacity");
    const next=await queue.capture({...monitor,browser_steps:[],disable_javascript:true},root,limits);
    assert.equal(next.ok,true,"A fresh Chromium capture must work after another monitor fails");
    assert.equal(queue.status.capture,false);
  }finally{queue.close();rmSync(root,{recursive:true,force:true});}
});

test("real mobile Preview uses the mobile viewport and releases its slot", {timeout:90000},async()=>{
  const queue=new BrowserQueue(),ownerId=randomUUID(),mobile={...monitor,mobile_view:true};
  let active;
  try{
    const result=await previewRegion(mobile,limits,undefined,new EgressPolicy(),{
      ownerId,retain:true,acquireCapacity:async(_onWait,waitMs)=>queue.acquirePreview({waitMs})
    });
    active=result.session_id;
    assert.ok(result.width<600&&result.height>=600,"Mobile capture must use narrow touch viewport");
    assert.ok(result.image.length>100);
    const next=await previewRegion(mobile,limits,undefined,new EgressPolicy(),{
      ownerId,id:result.session_id,retain:true,scrollDeltaY:120
    });
    assert.equal(next.reused,true,"Mobile scroll should use the retained interactive session");
  }finally{if(active)await releaseRegionPreviewSession(ownerId,active);queue.close();}
});

test("real Chromium Preview scrolls both axes and replays x/y Browser Step during capture",{timeout:90000},async()=>{
  const fixture=http.createServer((_req,res)=>{
    res.writeHead(200,{"Content-Type":"text/html"});
    res.end('<!doctype html><html><body style="margin:0"><div style="width:2600px;height:2000px;background:white"></div><div id="target" style="position:absolute;left:620px;top:520px;width:300px;height:300px;background:rgb(0,0,255)">Target</div></body></html>');
  });
  await new Promise(resolve=>fixture.listen(0,"127.0.0.1",resolve));
  const port=fixture.address().port,url=`http://127.0.0.1:${port}/page`;
  // Only this isolated fixture permits loopback; production EgressPolicy is unchanged.
  const policy=new EgressPolicy(undefined,()=>true,new Set([port]));
  const queue=new BrowserQueue(),ownerId=randomUUID();let sessionId;
  try {
    const m={...monitor,url,disable_javascript:false};
    const initial=await previewRegion(m,limits,undefined,policy,{ownerId,retain:true,acquireCapacity:async(_wait,waitMs)=>queue.acquirePreview({waitMs})});
    sessionId=initial.session_id;
    const moved=await previewRegion(m,limits,undefined,policy,{ownerId,id:sessionId,retain:true,scrollDelta:{x:600,y:500}});
    assert.ok(moved.scroll_x>=590&&moved.scroll_y>=490,"both axes must move in server Chromium");
    await releaseRegionPreviewSession(ownerId,sessionId);sessionId=undefined;
    const result=await capture({...m,capture_mode:"selected_area",capture_area:{x:25,y:25,width:80,height:80},
      browser_steps:[{action:"scroll_by",x:600,y:500,timeout_ms:5000,continue_on_error:false}]},limits,policy);
    const frame=PNG.sync.read(result.screenshot);
    const pixel=(40*frame.width+40)*4;
    assert.ok(frame.data[pixel+2]>180&&frame.data[pixel]<100,"saved x/y step must reveal the target in capture");
  }finally{
    if(sessionId)await releaseRegionPreviewSession(ownerId,sessionId);
    queue.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
  }
});

test("Ghostery blocks real Chromium ad requests in capture and Preview while OFF stays unblocked",{timeout:90000},async()=>{
  const hits={ad:0,ordinary:0};
  const fixture=http.createServer((req,res)=>{
    if(req.url==="/analytics.js"){hits.ad++;res.writeHead(200,{"Content-Type":"application/javascript"});res.end('document.body.insertAdjacentHTML("beforeend","<p>ad loaded</p>")');return;}
    if(req.url==="/ordinary.js"){hits.ordinary++;res.writeHead(200,{"Content-Type":"application/javascript"});res.end('document.body.insertAdjacentHTML("beforeend","<p id=ordinary>ordinary loaded</p>")');return;}
    res.writeHead(200,{"Content-Type":"text/html"});
    res.end(`<!doctype html><html><body><h1>Fixture</h1><script src="http://adnxs.com:${fixture.address().port}/analytics.js"></script><script src="http://cdn.example.com:${fixture.address().port}/ordinary.js"></script></body></html>`);
  });
  await new Promise(resolve=>fixture.listen(0,"127.0.0.1",resolve));
  const port=fixture.address().port,url=`http://site.example.com:${port}/page`;
  // Isolated fixture only: every test hostname resolves to this local server.
  const policy=new EgressPolicy(async()=>[{address:"127.0.0.1",family:4}],()=>true,new Set([port]));
  const configured={...monitor,url,visual_enabled:false,disable_javascript:false,block_ads_trackers:true};
  let owner=randomUUID(),sessionId;
  try{
    const beforeRss=process.memoryUsage().rss,started=performance.now();
    const blocked=await capture(configured,limits,policy);
    const enabledMs=Math.round(performance.now()-started),engineRssMiB=Math.round((process.memoryUsage().rss-beforeRss)/1048576);
    assert.match(blocked.text,/ordinary loaded/);
    assert.doesNotMatch(blocked.text,/ad loaded/);
    assert.deepEqual(hits,{ad:0,ordinary:1});
    const replayStarted=performance.now();
    const replay=await capture({...configured,browser_steps:[{action:"wait_selector",selector:"#ordinary",selector_type:"css",timeout_ms:5000,continue_on_error:false}]},limits,policy);
    const warmEnabledMs=Math.round(performance.now()-replayStarted);
    assert.match(replay.text,/ordinary loaded/);
    const preview=await previewRegion({...configured,visual_enabled:true},limits,undefined,policy,{ownerId:owner,retain:true,captureLayout:false});
    sessionId=preview.session_id;
    assert.ok(preview.image.length>100);
    assert.equal(hits.ad,0,"Preview shares Ghostery blocking with capture and Browser Steps");
    await releaseRegionPreviewSession(owner,sessionId);sessionId=undefined;
    const offStarted=performance.now();
    const unblocked=await capture({...configured,block_ads_trackers:false},limits,policy);
    const disabledMs=Math.round(performance.now()-offStarted);
    assert.equal(hits.ad,1,JSON.stringify(hits));
    assert.match(unblocked.text,/ad loaded/);
    console.log(JSON.stringify({code:"ghostery_fixture_performance",cold_enabled_capture_ms:enabledMs,warm_enabled_with_step_ms:warmEnabledMs,disabled_capture_ms:disabledMs,shared_engine_rss_delta_mib:engineRssMiB}));
  }finally{
    if(sessionId)await releaseRegionPreviewSession(owner,sessionId);
    fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
  }
});

test("long-page Preview remains selectable beyond its original 45-second expiry after real scrolling",{timeout:90000},async()=>{
  const fixture=http.createServer((_req,res)=>{
    res.writeHead(200,{"Content-Type":"text/html"});
    res.end('<!doctype html><html><body style="margin:0"><div style="width:2600px;height:2000px"></div><button id="target" style="position:absolute;left:620px;top:520px;width:160px;height:80px">Select target</button></body></html>');
  });
  await new Promise(resolve=>fixture.listen(0,"127.0.0.1",resolve));
  const port=fixture.address().port,url=`http://127.0.0.1:${port}/page`,policy=new EgressPolicy(undefined,()=>true,new Set([port]));
  const queue=new BrowserQueue(),ownerId=randomUUID(),m={...monitor,url,disable_javascript:false};
  let sessionId,originalNow=Date.now;
  try {
    const initial=await previewRegion(m,limits,undefined,policy,{ownerId,retain:true,acquireCapacity:async(_wait,waitMs)=>queue.acquirePreview({waitMs})});
    sessionId=initial.session_id;
    assert.ok(initial.expires_at-Date.now()<=45000&&initial.expires_at-Date.now()>42000);
    const ineffective=await previewRegion(m,limits,undefined,policy,{ownerId,id:sessionId,retain:true,scrollDelta:{x:-100,y:-100}});
    assert.equal(ineffective.expires_at,initial.expires_at,"scrolling against the viewport edge does not renew the session");
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,initial.expires_at-Date.now()-3000)));
    const moved=await previewRegion(m,limits,undefined,policy,{ownerId,id:sessionId,retain:true,scrollDelta:{x:600,y:500}});
    assert.ok(moved.expires_at>=initial.expires_at+19000&&moved.expires_at<=initial.expires_at+20000);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,initial.expires_at-Date.now()+1000)));
    const selected=await previewRegion(m,limits,{x:50,y:50},policy,{ownerId,id:sessionId,retain:true});
    assert.equal(selected.selection?.selector,"#target");
    assert.equal(selected.expires_at,moved.expires_at,"selection alone does not renew the session");
    Date.now=()=>moved.expires_at+1;
    await assert.rejects(previewRegion(m,limits,undefined,policy,{ownerId,id:sessionId,retain:true}),error=>error.status===410&&error.failure_code==="session_expired");
    Date.now=originalNow;
    sessionId=undefined;
    assert.equal(queue.status.preview,false,"expired session releases the confirmed Chromium lease");
  }finally{
    Date.now=originalNow;
    if(sessionId)await releaseRegionPreviewSession(ownerId,sessionId);
    queue.close();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
  }
});

test("real Chromium Text Picker extraction matches selected hybrid capture and Browser Steps replay",{timeout:90000},async()=>{
  let price="12";
  const fixture=http.createServer((_req,res)=>{
    res.writeHead(200,{"Content-Type":"text/html"});
    res.end(`<html><body><main id="product"><p>Product</p><p>Price: ${price} USD</p><p>Seller</p><p>Delivery</p></main></body></html>`);
  });
  await new Promise(resolve=>fixture.listen(0,"127.0.0.1",resolve));
  const port=fixture.address().port,url=`http://127.0.0.1:${port}/product`,policy=new EgressPolicy(undefined,()=>true,new Set([port]));
  const rule={version:1,kind:"bounded_context",before:"Price: ",after:" USD",max_length:64};
  const m={...monitor,url,selector:"#product",visual_enabled:false,extraction_mode:"full_text",browser_steps:[{action:"wait_selector",selector:"#product",selector_type:"css",timeout_ms:10000,continue_on_error:false}]};
  try{
    const preview=await capture(m,limits,policy,undefined,true);
    assert.match(preview.text,/Price: 12 USD/);
    const selected={...m,visual_enabled:true,extraction_mode:"selected_text",extraction_rule:rule};
    const first=await capture(selected,limits,policy);
    assert.equal(first.text,"12");assert.ok(first.screenshot?.length);
    price="13";
    const second=await capture(selected,limits,policy);
    assert.equal(second.text,"13");assert.ok(second.screenshot?.length);
  }finally{fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));}
});

test("long Direct Browser blocks and repeated values select the clicked hybrid target",{timeout:90000},async()=>{
  const value="34.819,01 ₺";
  let second=value;
  const fixture=http.createServer((_req,res)=>{
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    res.end(`<html><head><meta charset="utf-8"></head><body><main id="product"><h1>Product</h1><p>${value}</p><p>${second}</p><p>Kredi kartınızdan ${value} çekilecek.</p><p>${"A long description. ".repeat(90)}</p></main></body></html>`);
  });
  await new Promise(resolve=>fixture.listen(0,"127.0.0.1",resolve));
  const port=fixture.address().port,url=`http://127.0.0.1:${port}/product`,policy=new EgressPolicy(undefined,()=>true,new Set([port]));
  const m={...monitor,url,selector:"#product",visual_enabled:false,extraction_mode:"full_text",browser_steps:[{action:"wait_selector",selector:"#product",selector_type:"css",timeout_ms:10000,continue_on_error:false}]};
  try{
    const preview=await capture(m,limits,policy,undefined,true);
    const lines=segmentSelectedText(preview.text).map(item=>item.text);
    assert.ok(lines.length>5,"long browser paragraph is segmented");
    const duplicates=lines.map((text,index)=>text===value?index:-1).filter(index=>index>=0);
    assert.equal(duplicates.length,2);
    const rule=generateSelectedTextRule(lines,duplicates[1],value).rule;
    const selected={...m,visual_enabled:true,extraction_mode:"selected_text",extraction_rule:rule};
    const first=await capture(selected,limits,policy);
    assert.equal(first.text,value);assert.ok(first.screenshot?.length);
    second="35.000,00 ₺";
    const changed=await capture(selected,limits,policy);
    assert.equal(changed.text,second);assert.ok(changed.screenshot?.length);
  }finally{fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));}
});
