// Real sandboxed Chromium acceptance smoke. Runs inside the built Simple image.
// Uses a public, non-private HTTPS page so SSRF policy remains enforced.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {PNG} from "pngjs";
import {BrowserQueue} from "./browser-queue.mjs";
import {previewRegion,releaseRegionPreviewSession} from "../server/dist/region-picker.js";
import {EgressPolicy} from "../server/dist/egress.js";

const page="https://example.com/";
const monitor={
  id:randomUUID(),user_id:randomUUID(),name:"Real browser smoke",
  url:page,kind:"browser",text_enabled:true,visual_enabled:true,
  selector:"",selector_type:"css",ignore_selectors:[],mask_selectors:[],ignore_text:[],
  normalize_whitespace:true,ignore_case:false,capture_mode:"viewport",
  capture_selector:"",capture_selector_type:"css",capture_area:null,
  browser_steps:[{action:"wait_selector",selector:"h1",selector_type:"css",timeout_ms:10000,continue_on_error:false}],
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
      {capture_mode:"element",capture_selector:"h1",capture_area:null},
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
