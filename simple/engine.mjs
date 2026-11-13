import { randomUUID,createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compareText, compareKeywordPresence, normalizeText as existingNormalizeText } from "../server/dist/text-comparison.js";
import { BrowserQueue } from "./browser-queue.mjs";
import { getMonitor, transaction } from "./db.mjs";
import { deliver, safeTextSummary } from "../server/dist/notifications.js";
import { decrypt } from "../server/dist/crypto.js";
import { openValues } from "../server/dist/vault.js";
import { Storage } from "../server/dist/storage.js";

export function normalizeText(value,monitor) {
  return existingNormalizeText(String(value??""),{
    ignore_text:monitor.ignore_text??[],normalize_whitespace:monitor.normalize_whitespace!==false,
    ignore_case:!!monitor.ignore_case
  });
}
export async function compareCaptures(before,after,monitor,root) {
  const prior=monitor.kind==="file"?String(before?.text_content??""):normalizeText(before?.text_content,monitor);
  const next=monitor.kind==="file"?String(after.text??""):normalizeText(after.text,monitor);
  const text=before&&monitor.text_enabled!==false
    ? monitor.extraction_mode==="keyword_presence"&&monitor.keyword
      ? compareKeywordPresence(prior,next,monitor.keyword)
      : compareText(prior,next)
    : {changed:false,parts:[]};
  const visual=before?.screenshot&&after.screenshot&&monitor.visual_enabled
    ? (await import("../server/dist/comparison.js")).compareVisual(
      readFileSync(path.join(root,"artifacts",before.screenshot)),
      readFileSync(path.join(root,"artifacts",after.screenshot)),
      String(monitor.visual_threshold??"0.35"),Number(monitor.pixel_threshold??0.1))
    : null;
  const httpStatusChanged=Boolean(before&&monitor.monitor_http_error_pages&&before.http_status!==after.http_status);
  return {textChanged:text.changed,textDiff:text.parts.slice(0,100),
    visualChanged:visual?.changed??false,visualPercent:visual?.percent??null,
    dimensionChanged:visual?.dimensionChanged??false,diffImage:visual?.changed?visual?.diff??null:null,
    beforeDimensions:visual?.beforeDimensions??null,afterDimensions:visual?.afterDimensions??null,
    httpStatusChanged};
}
export function textDirectionMatches(parts,direction) {
  if(!direction||direction==="both")return true;
  return direction==="added"?parts.some(part=>part.added):parts.some(part=>part.removed);
}

export function queueEventNotification(db,m,event,now,{directionAllowed=true,deduplicate=true}={}){
  const mark=state=>{
    event.notification_state=state;
    db.prepare("UPDATE events SET payload=? WHERE id=?").run(JSON.stringify(event),event.id);
  };
  if(m.notification_enabled===false){mark("disabled");return;}
  if(m.muted_until&&Date.parse(m.muted_until)>now){mark("muted");return;}
  if(!directionAllowed){mark("direction_filtered");return;}
  const channels=db.prepare("SELECT mc.channel_id FROM monitor_channels mc JOIN channels c ON c.id=mc.channel_id WHERE mc.monitor_id=? AND c.user_id=? AND json_extract(c.payload,'$.enabled')=1").all(m.id,m.user_id);
  if(!channels.length){mark("not_requested");return;}
  const fingerprint=createHash("sha256").update(JSON.stringify({
    status:event.status,text:event.text_diff??[],visual:event.visual_changed?{percent:event.visual_percent,dimensions:event.dimension_changed}:null,
    http:event.http_status_changed?event.http_status:null,error:event.status==="failed"?event.error:null
  })).digest("hex");
  event.notification_fingerprint=fingerprint;
  if(m.notification_mode==="digest"){
    const due=now+Math.max(300000,Number(m.digest_window_seconds??3600)*1000);
    for(const {channel_id} of channels)db.prepare(
      "INSERT INTO notification_digests(monitor_id,channel_id,first_event_at,last_event_at,event_count,latest_event_id,due_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(monitor_id,channel_id) DO UPDATE SET last_event_at=excluded.last_event_at,event_count=notification_digests.event_count+1,latest_event_id=excluded.latest_event_id"
    ).run(m.id,channel_id,now,now,1,event.id,due);
    mark("digest_pending");return;
  }
  if(deduplicate){
    const duplicate=db.prepare(
      "SELECT 1 FROM events e JOIN outbox o ON o.event_id=e.id WHERE e.monitor_id=? AND json_extract(e.payload,'$.notification_fingerprint')=? AND o.status IN ('pending','sent') AND e.created_at>? LIMIT 1"
    ).get(m.id,fingerprint,now-86400000);
    if(duplicate){mark("duplicate_suppressed");return;}
  }
  const cooldown=Number(m.notification_cooldown_seconds??0);
  if(cooldown>0){
    const recent=db.prepare(
      "SELECT 1 FROM events e JOIN outbox o ON o.event_id=e.id WHERE e.monitor_id=? AND o.status IN ('pending','sent') AND e.created_at>? LIMIT 1"
    ).get(m.id,now-cooldown*1000);
    if(recent){mark("cooldown");return;}
  }
  for(const {channel_id} of channels)db.prepare(
    "INSERT OR IGNORE INTO outbox(id,event_id,channel_id,next_attempt,payload) VALUES(?,?,?,?,?)"
  ).run(randomUUID(),event.id,channel_id,now,JSON.stringify({eventId:event.id}));
  mark("queued");
}

export class FusionEngine {
  constructor(db,opts={}) {
    this.db=db;this.dataDir=opts.dataDir;this.publicUrl=opts.publicUrl??"http://127.0.0.1:3000";
    this.channelKey=opts.channelKey;this.browser=opts.browser??new BrowserQueue();
    this.manual=[];this.manualStatus=new Map();this.working=false;this.runningKind=null;this.closed=false;this.interval=null;
    this.storage=new Storage(path.join(this.dataDir,"artifacts"));
    this.sendNotification=opts.sendNotification??deliver;
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
    if(this.runningKind==="scheduled")this.browser.preemptScheduledCapture();
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
    this.runningKind=item?"manual":"scheduled";
    try {await this.#check(monitor,item);}
    finally {
      if(item&&item.status==="running"){item.status="completed";item.updated_at=new Date().toISOString();}
      this.working=false;
      this.runningKind=null;
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
    if(!item&&this.manual.length){
      this.db.prepare("UPDATE monitors SET next_run=? WHERE id=?").run(Date.now()+5000,m.id);
      return;
    }
    const fileBefore=m.kind==="file"&&m.baseline_id?this.db.prepare("SELECT text_content FROM captures WHERE id=?").get(m.baseline_id):null;
    const captureMonitor=m.kind==="file"?{...m,file_baseline:fileBefore?.text_content??null}:m;
    const result=await this.browser.capture(captureMonitor,this.dataDir,{CAPTURE_TIMEOUT_MS:30000});
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
    try {comparison=await compareCaptures(before,actual,m,this.dataDir);}
    catch {this.#failure(m,"comparison_failed",delay,item);return;}
    const afterId=randomUUID(),eventId=randomUUID(),now=Date.now(),first=!before;
    let diffName=null;
    if(comparison.diffImage)diffName=await this.storage.save(comparison.diffImage);
    const status=first?"baseline":comparison.textChanged||comparison.visualChanged||comparison.httpStatusChanged?"changed":"unchanged";
    const event={id:eventId,monitor_id:m.id,status,source_kind:m.kind,
      text_changed:comparison.textChanged,visual_changed:comparison.visualChanged,http_status_changed:comparison.httpStatusChanged,
      visual_percent:comparison.visualPercent,dimension_changed:comparison.dimensionChanged,before_dimensions:comparison.beforeDimensions,after_dimensions:comparison.afterDimensions,
      text_diff:comparison.textDiff,diff_screenshot:diffName,http_status:result.http_status,before_http_status:before?.http_status??null,
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
      payload.last_error=null;payload.last_http_status=result.http_status??null;payload.execution_ms=event.execution_ms;
      if(m.kind==="file"){
        try{payload.file_metadata=JSON.parse(actual.text);}catch{payload.file_metadata=null;}
      }
      payload.warning_code=result.warning??null;
      if(status==="changed")payload.last_change_at=event.created_at;
      this.db.prepare("UPDATE monitors SET payload=?,last_run=?,last_success=?,next_run=?,last_status=?,failure_count=0 WHERE id=?")
        .run(JSON.stringify(payload),now,now,now+delay,status==="changed"?"changed":"healthy",m.id);
      if(status==="changed")queueEventNotification(this.db,m,event,now,{
        directionAllowed:!comparison.textChanged||comparison.visualChanged||comparison.httpStatusChanged||textDirectionMatches(comparison.textDiff,m.text_direction)
      });
    });
    if(status==="changed")void this.deliverPending().catch(()=>{});
  }
  #failure(m,code,delay,item){
    const now=Date.now(),failure=Number(m.failure_count??0)+1,evt=randomUUID();
    const state=failure>=3?"persistent_failure":"temporary_failure";
    const mode=m.failure_alert_mode??(m.notify_failures?"first_or_persistent":"off");
    const shouldNotify=mode==="every"||(mode==="first_or_persistent"&&(failure===1||(state==="persistent_failure"&&m.monitor_state!==state)));
    transaction(this.db,()=>{
      const row=this.db.prepare("SELECT payload FROM monitors WHERE id=?").get(m.id);
      const payload=JSON.parse(row.payload);payload.last_error=String(code).slice(0,64);
      this.db.prepare("UPDATE monitors SET payload=?,last_run=?,next_run=?,last_status=?,failure_count=? WHERE id=?")
        .run(JSON.stringify(payload),now,now+delay,state,failure,m.id);
      const event={id:evt,monitor_id:m.id,status:"failed",error:String(code).slice(0,64),failure_code:String(code).slice(0,64),
        created_at:new Date(now).toISOString(),notification_state:"not_requested"};
      this.db.prepare("INSERT INTO events(id,monitor_id,status,payload,created_at) VALUES(?,?,?,?,?)")
        .run(evt,m.id,"failed",JSON.stringify(event),now);
      if(shouldNotify)queueEventNotification(this.db,m,event,now,{deduplicate:false});
    });
    if(shouldNotify)void this.deliverPending().catch(()=>{});
    if(item){item.status="failed";item.updated_at=new Date().toISOString();}
  }
  #flushDigests(){
    const due=this.db.prepare("SELECT * FROM notification_digests WHERE due_at<=? ORDER BY due_at LIMIT 30").all(Date.now());
    for(const row of due)transaction(this.db,()=>{
      const now=Date.now(),id=randomUUID(),event={id,monitor_id:row.monitor_id,status:"digest",
        created_at:new Date(now).toISOString(),notification_state:"queued",
        metadata:{digest_count:row.event_count,period_start:new Date(row.first_event_at).toISOString(),period_end:new Date(row.last_event_at).toISOString()}};
      this.db.prepare("INSERT INTO events(id,monitor_id,status,payload,created_at) VALUES(?,?,?,?,?)").run(id,row.monitor_id,"digest",JSON.stringify(event),now);
      this.db.prepare("INSERT INTO outbox(id,event_id,channel_id,next_attempt,payload) VALUES(?,?,?,?,?)").run(randomUUID(),id,row.channel_id,now,JSON.stringify({eventId:id}));
      this.db.prepare("DELETE FROM notification_digests WHERE monitor_id=? AND channel_id=?").run(row.monitor_id,row.channel_id);
    });
  }
  async deliverPending(){
    if(this.delivering||this.closed)return;
    this.delivering=true;
    try {
      this.#flushDigests();
      const rows=this.db.prepare("SELECT o.*,c.payload AS channel,e.payload AS event,m.payload AS monitor FROM outbox o JOIN channels c ON c.id=o.channel_id JOIN events e ON e.id=o.event_id JOIN monitors m ON m.id=e.monitor_id WHERE o.status IN ('pending','failed') AND o.next_attempt<=? AND o.attempts<5 ORDER BY o.next_attempt LIMIT 10").all(Date.now());
      for(const row of rows){
        const channel=JSON.parse(row.channel),e=JSON.parse(row.event),m=JSON.parse(row.monitor);
        if(!channel.enabled){this.db.prepare("UPDATE outbox SET status='disabled' WHERE id=?").run(row.id);continue;}
        // Preserve the legacy Telegram safety gate when importing an unverified channel.
        if(channel.provider==="telegram" && channel.config?.preview_test_required && !channel.config?.preview_verified && e.status!=="test"){
          const payload={...JSON.parse(row.payload),last_error:"test_notification_required"};
          this.db.prepare("UPDATE outbox SET status='failed',attempts=5,payload=? WHERE id=?")
            .run(JSON.stringify(payload),row.id);
          continue;
        }
        const before=e.before_id?this.db.prepare("SELECT screenshot FROM captures WHERE id=?").get(e.before_id):null;
        const after=e.after_id?this.db.prepare("SELECT screenshot FROM captures WHERE id=?").get(e.after_id):null;
        const visualSet=[["before",before?.screenshot],["after",after?.screenshot],["diff",e.diff_screenshot]].filter(([,name])=>Boolean(name));
        const images=visualSet.map(([,name])=>name);
        const details={id:e.id,name:m.name,monitorId:m.id,textChanged:e.text_changed,visualChanged:e.visual_changed,
          dimensionChanged:e.dimension_changed,beforeDimensions:e.before_dimensions,afterDimensions:e.after_dimensions,
          httpStatus:e.http_status,previousHttpStatus:e.before_id?this.db.prepare("SELECT http_status FROM captures WHERE id=?").get(e.before_id)?.http_status:null,httpStatusChanged:e.http_status_changed,
          percent:e.visual_percent,textSummary:safeTextSummary(e.text_diff??[]),
          link:new URL("/jobs/"+m.id,this.publicUrl).href,images,imageLabels:visualSet.map(([label])=>label),
          checkedAt:e.created_at,eventType:e.status,attentionMessage:e.error??null,
          digestCount:e.metadata?.digest_count,digestStart:e.metadata?.period_start,digestEnd:e.metadata?.period_end};
        try{
          const configuration=decrypt(channel.config.encrypted,this.channelKey);
          await this.sendNotification(channel.provider,configuration,details,this.storage);
          const payload={...JSON.parse(row.payload),delivered_at:new Date().toISOString(),last_error:null};
          this.db.prepare("UPDATE outbox SET status='sent',attempts=attempts+1,payload=? WHERE id=?").run(JSON.stringify(payload),row.id);
          if(channel.provider==="telegram" && e.status==="test" && channel.config?.preview_test_required){
            // A test of old credentials must not unlock a channel edited during delivery.
            this.db.prepare("UPDATE channels SET payload=json_set(payload,'$.config.preview_verified',json('true')) WHERE id=? AND json_extract(payload,'$.config.encrypted')=? AND json_extract(payload,'$.config.preview_test_required')=1")
              .run(row.channel_id,channel.config.encrypted);
          }
        } catch {
          const attempt=row.attempts+1;
          const payload={...JSON.parse(row.payload),last_error:"delivery_failed",last_attempt_at:new Date().toISOString()};
          this.db.prepare("UPDATE outbox SET status=?,attempts=?,next_attempt=?,payload=? WHERE id=?").run(attempt>=5?"failed":"pending",attempt,Date.now()+Math.min(3600000,30000*2**attempt),JSON.stringify(payload),row.id);
        }
      }
    }finally{this.delivering=false;}
  }
}
