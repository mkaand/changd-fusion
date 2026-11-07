import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { diffWords } from "diff";
import { BrowserQueue } from "./browser-queue.mjs";
import { getMonitor, transaction } from "./db.mjs";
import { deliver, safeTextSummary } from "../server/dist/notifications.js";
import { decrypt } from "../server/dist/crypto.js";
import { openValues } from "../server/dist/vault.js";
import { Storage } from "../server/dist/storage.js";

export function normalizeText(value,monitor) {
  let text=String(value??"");
  for(const part of monitor.ignore_text??[]) if(typeof part==="string"&&part)text=text.split(part).join("");
  if(monitor.normalize_whitespace!==false) text=text.replace(/\s+/g," ").trim();
  if(monitor.ignore_case) text=text.toLocaleLowerCase();
  return text;
}
export function compareCaptures(before,after,monitor,root) {
  const prior=normalizeText(before?.text_content,monitor),next=normalizeText(after.text,monitor);
  const textChanged=!!before && monitor.text_enabled!==false && prior!==next;
  const textDiff=textChanged?diffWords(prior,next).slice(0,100):[];
  let visualChanged=false,visualPercent=null,dimensionChanged=false,diffImage=null;
  if(before?.screenshot && after.screenshot && monitor.visual_enabled){
    const a=PNG.sync.read(readFileSync(path.join(root,"artifacts",before.screenshot)));
    const b=PNG.sync.read(readFileSync(path.join(root,"artifacts",after.screenshot)));
    if(a.width!==b.width||a.height!==b.height){
      visualChanged=true; dimensionChanged=true;
    }else{
      const output=new PNG({width:a.width,height:a.height});
      const changed=pixelmatch(a.data,b.data,output.data,a.width,a.height,{threshold:Number(monitor.pixel_threshold??0.1)});
      visualPercent=String(changed*100/(a.width*a.height));
      visualChanged=Number(visualPercent)>Number(monitor.visual_threshold??0.35);
      if(visualChanged) diffImage=PNG.sync.write(output);
    }
  }
  return {textChanged,textDiff,visualChanged,visualPercent,dimensionChanged,diffImage};
}

export class FusionEngine {
  constructor(db,opts={}) {
    this.db=db;this.dataDir=opts.dataDir;this.publicUrl=opts.publicUrl??"http://127.0.0.1:3000";
    this.channelKey=opts.channelKey;this.browser=opts.browser??new BrowserQueue();
    this.manual=[];this.manualStatus=new Map();this.working=false;this.closed=false;this.interval=null;
    this.storage=new Storage(path.join(this.dataDir,"artifacts"));
  }
  start(){
    if(this.interval)return;
    this.interval=setInterval(()=>void this.tick().catch(()=>{}),2500);
    this.interval.unref();
    void this.tick().catch(()=>{});
  }
  close(){
    this.closed=true;clearInterval(this.interval);this.interval=null;this.browser.close();
  }
  enqueue(id,userId){
    const m=getMonitor(this.db,id,userId);
    if(!m)throw Error("monitor_not_found");
    if(!m.enabled||m.paused)throw Error("monitor_disabled");
    const previous=[...this.manualStatus.values()].find(x=>x.monitorId===id&&["queued","running"].includes(x.status));
    if(previous)return previous;
    if(this.manual.length>=16)throw Error("manual_queue_full");
    const item={id:randomUUID(),monitorId:id,userId,status:"queued",created_at:new Date().toISOString(),updated_at:new Date().toISOString()};
    this.manual.push(item);this.manualStatus.set(item.id,item);
    setImmediate(()=>void this.tick().catch(()=>{}));
    return item;
  }
  manualFor(id,userId){
    return [...this.manualStatus.values()].reverse().find(x=>x.monitorId===id&&x.userId===userId)??{status:"idle"};
  }
  cancelManual(id,userId){
    const item=this.manual.find(x=>x.monitorId===id&&x.userId===userId&&x.status==="queued");
    if(item){item.status="cancelled";item.updated_at=new Date().toISOString();this.manual=this.manual.filter(x=>x!==item);return true;}
    return false;
  }
  async tick(){
    if(this.closed||this.working||this.browser.status.preview)return;
    let item=this.manual.shift();
    if(item?.status==="cancelled")item=null;
    let monitor;
    if(item){
      monitor=getMonitor(this.db,item.monitorId,item.userId);
      if(!monitor||!monitor.enabled||monitor.paused){item.status="cancelled";return;}
      item.status="running";item.updated_at=new Date().toISOString();
    }else{
      const now=Date.now();
      const row=this.db.prepare("SELECT id,user_id FROM monitors WHERE enabled=1 AND paused=0 AND next_run<=? ORDER BY next_run ASC LIMIT 1").get(now);
      if(!row)return;
      monitor=getMonitor(this.db,row.id,row.user_id);
    }
    this.working=true;
    try {await this.#check(monitor,item);}
    finally {
      if(item&&item.status==="running"){item.status="completed";item.updated_at=new Date().toISOString();}
      this.working=false;
      if(this.manual.length)setImmediate(()=>void this.tick().catch(()=>{}));
    }
    if(this.manualStatus.size>100)for(const [id,run] of this.manualStatus)
      if(!["queued","running"].includes(run.status)){this.manualStatus.delete(id);if(this.manualStatus.size<=70)break;}
  }
  async #check(m,item){
    const started=Date.now();
    const delay=Math.max(30000,Math.min(604800000,Number(m.interval_seconds??300)*1000));
    const hasPrivate=(m.browser_steps??[]).some(x=>x.action==="fill_private");
    if(hasPrivate){
      const vault=this.db.prepare("SELECT payload FROM vault WHERE monitor_id=? AND user_id=?").get(m.id,m.user_id);
      if(!vault){this.#failure(m,"private_values_missing",delay,item);return;}
      try {m.private_values=openValues(JSON.parse(vault.payload),this.channelKey,m);}
      catch{this.#failure(m,"authentication_required",delay,item);return;}
    }
    const result=await this.browser.capture(m,this.dataDir,{CAPTURE_TIMEOUT_MS:30000});
    if(result.skipped){
      if(item){item.status="cancelled";item.updated_at=new Date().toISOString();}
      this.db.prepare("UPDATE monitors SET next_run=? WHERE id=?").run(Date.now()+5000,m.id);
      return;
    }
    if(!result.ok){this.#failure(m,result.code??"capture_failed",delay,item);return;}
    const beforeId=m.baseline_id;
    const before=beforeId?this.db.prepare("SELECT * FROM captures WHERE id=?").get(beforeId):null;
    const actual={text:result.text,screenshot:result.screenshot,http_status:result.http_status};
    let comparison;
    try {comparison=compareCaptures(before,actual,m,this.dataDir);}
    catch {this.#failure(m,"comparison_failed",delay,item);return;}
    const afterId=randomUUID(),eventId=randomUUID(),now=Date.now(),first=!before;
    let diffName=null;
    if(comparison.diffImage)diffName=await this.storage.save(comparison.diffImage);
    const status=first?"baseline":comparison.textChanged||comparison.visualChanged?"changed":"unchanged";
    const event={id:eventId,monitor_id:m.id,status,
      text_changed:comparison.textChanged,visual_changed:comparison.visualChanged,
      visual_percent:comparison.visualPercent,dimension_changed:comparison.dimensionChanged,
      text_diff:comparison.textDiff,diff_screenshot:diffName,http_status:result.http_status,
      warning_code:result.warning??null,execution_ms:Date.now()-started,
      created_at:new Date(now).toISOString(),notification_state:"not_requested",
      before_id:before?.id??null,after_id:afterId};
    transaction(this.db,()=>{
      this.db.prepare("INSERT INTO captures(id,monitor_id,text_content,screenshot,http_status,created_at) VALUES(?,?,?,?,?,?)")
        .run(afterId,m.id,actual.text??null,actual.screenshot??null,actual.http_status??null,now);
      this.db.prepare("INSERT INTO events(id,monitor_id,before_id,after_id,status,payload,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(eventId,m.id,before?.id??null,afterId,status,JSON.stringify(event),now);
      const oldState=this.db.prepare("SELECT payload FROM monitors WHERE id=?").get(m.id);
      const payload=JSON.parse(oldState.payload);
      payload.baseline_id=afterId;payload.latest_capture_id=afterId;payload.last_percent=comparison.visualPercent;
      this.db.prepare("UPDATE monitors SET payload=?,last_run=?,last_success=?,next_run=?,last_status=?,failure_count=0 WHERE id=?")
        .run(JSON.stringify(payload),now,now,now+delay,status==="changed"?"changed":"healthy",m.id);
      if(status==="changed"&&m.notification_enabled!==false){
        const links=this.db.prepare("SELECT mc.channel_id FROM monitor_channels mc JOIN channels c ON mc.channel_id=c.id WHERE mc.monitor_id=?").all(m.id);
        for(const {channel_id} of links)this.db.prepare("INSERT OR IGNORE INTO outbox(id,event_id,channel_id,next_attempt,payload) VALUES(?,?,?,?,?)")
          .run(randomUUID(),eventId,channel_id,now,JSON.stringify({eventId}));
      }
    });
    if(status==="changed")void this.deliverPending().catch(()=>{});
  }
  #failure(m,code,delay,item){
    const now=Date.now(),failure=Number(m.failure_count??0)+1,evt=randomUUID();
    transaction(this.db,()=>{
      const row=this.db.prepare("SELECT payload FROM monitors WHERE id=?").get(m.id);
      const payload=JSON.parse(row.payload);payload.last_error=String(code).slice(0,64);
      this.db.prepare("UPDATE monitors SET payload=?,last_run=?,next_run=?,last_status=?,failure_count=? WHERE id=?")
        .run(JSON.stringify(payload),now,now+delay,failure>=3?"persistent_failure":"temporary_failure",failure,m.id);
      this.db.prepare("INSERT INTO events(id,monitor_id,status,payload,created_at) VALUES(?,?,?,?,?)")
        .run(evt,m.id,"failed",JSON.stringify({id:evt,monitor_id:m.id,status:"failed",error:String(code).slice(0,64),created_at:new Date(now).toISOString()}),now);
    });
    if(item){item.status="failed";item.updated_at=new Date().toISOString();}
  }
  async deliverPending(){
    if(this.delivering||this.closed)return;
    this.delivering=true;
    try {
      const rows=this.db.prepare("SELECT o.*,c.payload AS channel,e.payload AS event,m.payload AS monitor FROM outbox o JOIN channels c ON c.id=o.channel_id JOIN events e ON e.id=o.event_id JOIN monitors m ON m.id=e.monitor_id WHERE o.status IN ('pending','failed') AND o.next_attempt<=? AND o.attempts<5 ORDER BY o.next_attempt LIMIT 10").all(Date.now());
      for(const row of rows){
        const channel=JSON.parse(row.channel),e=JSON.parse(row.event),m=JSON.parse(row.monitor);
        if(!channel.enabled){this.db.prepare("UPDATE outbox SET status='disabled' WHERE id=?").run(row.id);continue;}
        const before=e.before_id?this.db.prepare("SELECT screenshot FROM captures WHERE id=?").get(e.before_id):null;
        const after=e.after_id?this.db.prepare("SELECT screenshot FROM captures WHERE id=?").get(e.after_id):null;
        const images=[before?.screenshot,after?.screenshot,e.diff_screenshot].filter(Boolean);
        const details={id:e.id,name:m.name,monitorId:m.id,textChanged:e.text_changed,visualChanged:e.visual_changed,
          percent:e.visual_percent,textSummary:safeTextSummary(e.text_diff??[]),
          link:new URL("/jobs/"+m.id,this.publicUrl).href,images,
          checkedAt:e.created_at,eventType:e.status};
        try{
          const configuration=decrypt(channel.config.encrypted,this.channelKey);
          await deliver(channel.provider,configuration,details,this.storage);
          this.db.prepare("UPDATE outbox SET status='sent',attempts=attempts+1 WHERE id=?").run(row.id);
        } catch {
          const attempt=row.attempts+1;
          this.db.prepare("UPDATE outbox SET status=?,attempts=?,next_attempt=? WHERE id=?").run(attempt>=5?"failed":"pending",attempt,Date.now()+Math.min(3600000,30000*2**attempt),row.id);
        }
      }
    }finally{this.delivering=false;}
  }
}
