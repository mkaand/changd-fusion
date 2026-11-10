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
