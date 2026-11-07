import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSimpleDatabase,saveMonitor,getMonitor } from "./db.mjs";
import { FusionEngine } from "./engine.mjs";
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
