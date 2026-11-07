import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSimpleDatabase,saveMonitor,getMonitor } from "./db.mjs";
import { FusionEngine,compareCaptures,textDirectionMatches,queueEventNotification } from "./engine.mjs";
test("baseline, changed event and failed capture preserve settings",async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"fusion-simple-engine-"));let db,engine;
  try{
    db=openSimpleDatabase(path.join(dir,"fusion.sqlite"));
    const userId=randomUUID(),id=randomUUID();
    db.prepare("INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)")
      .run(userId,"monitor@example.com","bcrypt-hash",JSON.stringify({user_id:userId,email:"monitor@example.com",user_type:2}));
    const monitor={id,user_id:userId,name:"Retain settings",url:"https://example.com",kind:"api",
      text_enabled:true,visual_enabled:false,interval_seconds:30,enabled:true,paused:false,
      capture_mode:"viewport",browser_steps:[],notification_enabled:false,disable_javascript:true,
      ignore_text:[],ignore_selectors:[],mask_selectors:[],normalize_whitespace:true,ignore_case:false,
      next_run:new Date(Date.now()-1000).toISOString()};
    saveMonitor(db,monitor,userId);
    const results=[
      {ok:true,text:"first",screenshot:null,http_status:200},
      {ok:true,text:"second",screenshot:null,http_status:200},
      {failed:true,code:"timeout"}
    ];
    const browser={status:{preview:false},capture:async()=>results.shift(),close(){}};
    engine=new FusionEngine(db,{dataDir:dir,publicUrl:"http://localhost:8127",channelKey:"a".repeat(64),browser});
    await engine.tick();
    let m=getMonitor(db,id,userId);
    assert.ok(m.baseline_id);
    assert.equal(m.disable_javascript,true);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE status='baseline'").get().n,1);
    db.prepare("UPDATE monitors SET next_run=? WHERE id=?").run(Date.now()-1,id);
    await engine.tick();
    m=getMonitor(db,id,userId);const changedBaseline=m.baseline_id;
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE status='changed'").get().n,1);
    db.prepare("UPDATE monitors SET next_run=? WHERE id=?").run(Date.now()-1,id);
    await engine.tick();
    m=getMonitor(db,id,userId);
    assert.equal(m.baseline_id,changedBaseline,"failed capture must keep last valid baseline");
    assert.equal(m.disable_javascript,true,"monitor settings must be unchanged");
    assert.equal(m.failure_count,1);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE status='failed'").get().n,1);
  }finally{engine?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});

test("notification delivery records success, failure and safe retry metadata",async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"fusion-simple-notifications-"));let db,engine;
  try {
    db=openSimpleDatabase(path.join(dir,"fusion.sqlite"));
    const key="a".repeat(64),userId=randomUUID(),id=randomUUID(),channelId=randomUUID();
    const {encrypt}=await import("../server/dist/crypto.js");
    db.prepare("INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)")
      .run(userId,"notify@example.com","hash",JSON.stringify({user_id:userId,email:"notify@example.com",user_type:2}));
    saveMonitor(db,{id,user_id:userId,name:"Alert test",url:"https://example.com",kind:"api",enabled:true,paused:false,next_run:new Date(Date.now()+600000).toISOString()},userId);
    db.prepare("INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)").run(channelId,userId,JSON.stringify({
      id:channelId,user_id:userId,name:"Test channel",provider:"telegram",enabled:true,
      config:{encrypted:encrypt({token:"123456:"+ "a".repeat(25),chat_id:"1234",timezone:"UTC"},key)}
    }));
    db.prepare("INSERT INTO monitor_channels(monitor_id,channel_id) VALUES(?,?)").run(id,channelId);
    const eventId=randomUUID(),sendCalls=[];
    db.prepare("INSERT INTO events(id,monitor_id,status,payload,created_at) VALUES(?,?,?,?,?)").run(eventId,id,"changed",JSON.stringify({
      id:eventId,monitor_id:id,status:"changed",text_changed:true,visual_changed:false,
      text_diff:[{value:"changed",added:true,removed:false}],created_at:new Date().toISOString()
    }),Date.now());
    const deliveryId=randomUUID();
    db.prepare("INSERT INTO outbox(id,event_id,channel_id,next_attempt,payload) VALUES(?,?,?,?,?)")
      .run(deliveryId,eventId,channelId,Date.now(),JSON.stringify({eventId}));
    engine=new FusionEngine(db,{dataDir:dir,publicUrl:"http://localhost:8127",channelKey:key,
      browser:{close(){}},sendNotification:async(_provider,_configuration,event)=>{sendCalls.push(event);}});
    await engine.deliverPending();
    let row=db.prepare("SELECT * FROM outbox WHERE id=?").get(deliveryId);
    assert.equal(row.status,"sent");
    assert.equal(row.attempts,1);
    assert.ok(JSON.parse(row.payload).delivered_at);
    assert.equal(JSON.parse(row.payload).last_error,null);
    assert.equal(sendCalls.length,1);
    db.prepare("UPDATE outbox SET status='pending',attempts=0,next_attempt=? WHERE id=?").run(Date.now(),deliveryId);
    engine.sendNotification=async()=>{throw Error("secret server failure: token must not be stored");};
    await engine.deliverPending();
    row=db.prepare("SELECT * FROM outbox WHERE id=?").get(deliveryId);
    assert.equal(row.status,"pending");
    assert.equal(row.attempts,1);
    assert.equal(JSON.parse(row.payload).last_error,"delivery_failed");
    assert.equal(JSON.stringify(row).includes("secret server failure"),false);
  } finally {engine?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});

test("existing text and HTTP comparison semantics remain intact",()=>{
  const m={text_enabled:true,visual_enabled:false,normalize_whitespace:true,ignore_text:[],ignore_case:false,monitor_http_error_pages:true};
  const before={text_content:"Available",http_status:200},after={text:"Unavailable",http_status:404,screenshot:null};
  const changed=compareCaptures(before,after,m,"/unused");
  assert.equal(changed.textChanged,true);
  assert.equal(changed.httpStatusChanged,true);
  assert.equal(textDirectionMatches(changed.textDiff,"added"),true);
  assert.equal(textDirectionMatches(changed.textDiff,"removed"),true);
  const keyword=compareCaptures({text_content:"Product sold out",http_status:200},{text:"Product available",http_status:200,screenshot:null},
    {...m,extraction_mode:"keyword_presence",keyword:"available",monitor_http_error_pages:false},"/unused");
  assert.equal(keyword.textChanged,true);
  assert.equal(textDirectionMatches(keyword.textDiff,"added"),true);
  assert.equal(textDirectionMatches(keyword.textDiff,"removed"),false);
  assert.equal(compareCaptures(null,after,m,"/unused").textChanged,false,"first capture is a baseline");
});

test("notification mute, duplicate, cooldown and digest use one SQLite transaction store",async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"fusion-simple-parity-"));let db,engine;
  try {
    db=openSimpleDatabase(path.join(dir,"fusion.sqlite"));
    const {encrypt}=await import("../server/dist/crypto.js");
    const userId=randomUUID(),id=randomUUID(),channelId=randomUUID(),key="c".repeat(64);
    db.prepare("INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)")
      .run(userId,"parity@example.com","hash",JSON.stringify({user_id:userId,email:"parity@example.com",user_type:2}));
    const monitor={id,user_id:userId,name:"Notifications",url:"https://example.com",kind:"api",
      notification_enabled:true,notification_mode:"immediate",notification_cooldown_seconds:0};
    saveMonitor(db,{...monitor,enabled:true,paused:false,next_run:new Date().toISOString()},userId);
    db.prepare("INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)")
      .run(channelId,userId,JSON.stringify({id:channelId,user_id:userId,name:"Bot",provider:"telegram",enabled:true,
        config:{encrypted:encrypt({token:"123456:"+ "a".repeat(25),chat_id:"1234",timezone:"UTC"},key)}}));
    db.prepare("INSERT INTO monitor_channels(monitor_id,channel_id) VALUES(?,?)").run(id,channelId);
    let eventNo=0;
    const emit=(m=monitor,now=Date.now(),text="new value",directionAllowed=true)=>{
      const event={id:randomUUID(),monitor_id:id,status:"changed",text_diff:[{value:text,added:true,removed:false}],created_at:new Date(now).toISOString(),notification_state:"not_requested"};
      db.prepare("INSERT INTO events(id,monitor_id,status,payload,created_at) VALUES(?,?,?,?,?)").run(event.id,id,event.status,JSON.stringify(event),now);
      queueEventNotification(db,m,event,now,{directionAllowed});
      eventNo++;
      return event;
    };
    const first=emit();
    assert.equal(first.notification_state,"queued");
    assert.equal(db.prepare("SELECT count(*) n FROM outbox").get().n,1);
    assert.equal(emit().notification_state,"duplicate_suppressed");
    assert.equal(emit({...monitor,notification_cooldown_seconds:3600},Date.now(),"another update").notification_state,"cooldown");
    assert.equal(emit({...monitor,muted_until:new Date(Date.now()+3600000).toISOString()},Date.now(),"muted event").notification_state,"muted");
    assert.equal(emit(monitor,Date.now(),"direction filter",false).notification_state,"direction_filtered");
    const digestMonitor={...monitor,notification_mode:"digest",digest_window_seconds:300};
    assert.equal(emit(digestMonitor,Date.now(),"change A").notification_state,"digest_pending");
    assert.equal(emit(digestMonitor,Date.now(),"change B").notification_state,"digest_pending");
    assert.equal(db.prepare("SELECT event_count FROM notification_digests").get().event_count,2);
    db.prepare("UPDATE notification_digests SET due_at=?").run(Date.now()-1);
    const delivered=[];
    engine=new FusionEngine(db,{dataDir:dir,channelKey:key,publicUrl:"http://localhost:8127",
      browser:{close(){}},sendNotification:async(_p,_c,event)=>delivered.push(event)});
    await engine.deliverPending();
    assert.equal(db.prepare("SELECT count(*) n FROM notification_digests").get().n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE status='digest'").get().n,1);
    assert.equal(delivered.length,2,"one immediate alert and one consolidated digest");
    assert.equal(delivered.find(e=>e.eventType==="digest")?.digestCount,2);
  }finally{engine?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});
