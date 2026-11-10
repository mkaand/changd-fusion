import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeVisualVideo } from "../server/dist/visual-video.js";
import { deliver } from "../server/dist/notifications.js";
import { Storage } from "../server/dist/storage.js";
import { FusionEngine } from "./engine.mjs";
import { openSimpleDatabase, saveMonitor } from "./db.mjs";

const requireServer = createRequire(new URL("../server/dist/visual-video.js", import.meta.url));
const { PNG } = requireServer("pngjs");
const config = {token:"123456:"+"a".repeat(25),chat_id:"1234",timezone:"UTC"};
function png(width,height,red,green,blue) {
  const image=new PNG({width,height});
  for(let i=0;i<image.data.length;i+=4){image.data[i]=red;image.data[i+1]=green;image.data[i+2]=blue;image.data[i+3]=255;}
  return PNG.sync.write(image);
}
const images=()=>[png(120,80,255,0,0),png(80,120,0,255,0),png(64,64,0,0,255)];
const event=(names=[])=>({id:randomUUID(),name:"Firmware monitor",monitorId:randomUUID(),textChanged:false,visualChanged:true,
  percent:"12.5",textSummary:"",link:"https://example.com/jobs/123",images:names,imageLabels:["before","after","diff"],
  checkedAt:"2026-11-10T12:00:00Z",eventType:"changed"});
async function setup() {
  const dir=mkdtempSync(path.join(tmpdir(),"fusion-video-test-"));
  const storage=new Storage(path.join(dir,"artifacts"));
  const names=[];
  for(const image of images()) names.push(await storage.save(image));
  return {dir,storage,names};
}

test("three differently sized PNGs encode as one six-second silent H.264 video in order",async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"fusion-video-encode-"));
  try {
    const buffer=await encodeVisualVideo(images(),{tempRoot:root});
    assert.equal(buffer.toString("ascii",4,8),"ftyp");
    assert.equal(readdirSync(root).length,0,"temporary encoding files must be removed");
    const file=path.join(root,"test.mp4");writeFileSync(file,buffer);
    const info=JSON.parse(execFileSync("ffprobe",["-v","error","-show_entries","format=duration:stream=codec_type,codec_name,pix_fmt,width,height","-of","json",file]).toString());
    assert.ok(Number(info.format.duration)>5.8&&Number(info.format.duration)<6.3);
    assert.deepEqual(info.streams.map(s=>s.codec_type),["video"]);
    assert.equal(info.streams[0].codec_name,"h264");assert.equal(info.streams[0].pix_fmt,"yuv420p");
    assert.deepEqual([info.streams[0].width,info.streams[0].height],[960,540]);
    for(const [time,dominant] of [["0.5",0],["2.5",1],["4.5",2]]) {
      const pixel=execFileSync("ffmpeg",["-v","error","-ss",time,"-i",file,"-frames:v","1","-vf","crop=2:2:480:270","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
      assert.ok(pixel[dominant]>pixel[(dominant+1)%3]+80,`frame at ${time}s has expected color`);
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("encoder rejects oversized, absent and corrupt inputs and cleans files after timeout and failure",async()=>{
  const root=mkdtempSync(path.join(tmpdir(),"fusion-video-fail-"));
  try {
    await assert.rejects(encodeVisualVideo(images().slice(0,2),{tempRoot:root}),/Complete visual/);
    await assert.rejects(encodeVisualVideo([Buffer.from("broken"),...images().slice(1)],{tempRoot:root}),/Complete visual|Invalid PNG/);
    await assert.rejects(encodeVisualVideo(images(),{tempRoot:root,maxBytes:1024}),/size invalid|validation failed|encoding failed/);
    const fail=path.join(root,"fail"),slow=path.join(root,"slow");
    writeFileSync(fail,"#!/bin/sh\nexit 3\n");writeFileSync(slow,"#!/bin/sh\nexec sleep 5\n");chmodSync(fail,0o700);chmodSync(slow,0o700);
    await assert.rejects(encodeVisualVideo(images(),{tempRoot:root,ffmpeg:fail}),/encoding failed/);
    await assert.rejects(encodeVisualVideo(images(),{tempRoot:root,ffmpeg:slow,timeoutMs:20}),/timed out/);
    assert.deepEqual(readdirSync(root).sort(),["fail","slow"]);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("Telegram sends one multipart video with monitor, date and URL caption",async()=>{
  const {dir,storage,names}=await setup();
  try {
    const sent=[];
    await deliver("telegram",config,event(names),storage,{telegram:async(_token,method,body,type)=>sent.push({method,body,type})});
    assert.equal(sent.length,1);assert.equal(sent[0].method,"sendVideo");
    assert.match(sent[0].type,/multipart\/form-data/);
    const body=sent[0].body.toString("latin1");
    assert.match(body,/name="video"; filename="visual-change.mp4"/);
    assert.match(body,/Content-Type: video\/mp4/);
    assert.match(body,/Firmware monitor/);assert.match(body,/2026-11-10/);assert.match(body,/https:\/\/example.com\/jobs\/123/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("long caption uses a follow-up text message; encoding and delivery failure do not mark success",async()=>{
  const {dir,storage,names}=await setup();
  try {
    const large={...event(names),textChanged:true,textSummary:"a".repeat(900),name:"N".repeat(120)};
    const sent=[];
    await deliver("telegram",config,large,storage,{telegram:async(_token,method,body)=>sent.push({method,body}),videoEncoder:async()=>Buffer.from("fake-video")});
    assert.deepEqual(sent.map(s=>s.method),["sendVideo","sendMessage"]);
    assert.match(sent[1].body.toString(),/https:\/\/example.com\/jobs\/123/);
    const noSend=[];
    await assert.rejects(deliver("telegram",config,event(names),storage,{telegram:async(...args)=>noSend.push(args),videoEncoder:async()=>{throw Error("encode failed");}}),/encode failed/);
    assert.equal(noSend.length,0);
    await assert.rejects(deliver("telegram",config,event(names),storage,{telegram:async()=>{throw Error("Telegram failed");},videoEncoder:async()=>Buffer.from("fake-video")}),/Telegram failed/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("incomplete visual sets use existing PNG path; text, file and SMTP retain their delivery paths",async()=>{
  const {dir,storage,names}=await setup();
  try {
    const sent=[];
    const telegram=async(_token,method)=>sent.push(method);
    await deliver("telegram",config,{...event(names.slice(0,2)),imageLabels:["before","after"]},storage,{telegram,videoEncoder:async()=>{throw Error("video must not encode");}});
    assert.deepEqual(sent,["sendMessage","sendMediaGroup"]);
    sent.length=0;
    await deliver("telegram",config,{...event([]),visualChanged:false,textChanged:true,eventType:"changed"},storage,{telegram});
    await deliver("telegram",config,{...event([]),visualChanged:false,textChanged:true,eventType:"changed",name:"File metadata"},storage,{telegram});
    assert.deepEqual(sent,["sendMessage","sendMessage"]);
    const mails=[];
    const smtp=()=>({sendMail:async data=>mails.push(data),close(){}});
    await deliver("smtp",{host:"mail.example.com",port:465,from:"sender@example.com",to:"receiver@example.com"},event(names),storage,{smtp,policy:{target:async()=>({address:"93.184.215.14"})}});
    assert.equal(mails.length,1);assert.equal(mails[0].attachments.length,3);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("corrupt PNG fallback does not send a partial Telegram notification",async()=>{
  const {dir,storage,names}=await setup();
  try {
    const broken=await storage.save(Buffer.from("not-a-png"));
    const sent=[];
    await assert.rejects(deliver("telegram",config,{...event([names[0],broken]),imageLabels:["before","after"]},storage,{telegram:async(...args)=>sent.push(args)}),/Invalid PNG/);
    assert.equal(sent.length,0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("outbox retries failed visual delivery through the existing scheduler",async()=>{
  const {dir,storage,names}=await setup();let db,engine;
  try {
    db=openSimpleDatabase(path.join(dir,"db.sqlite"));const user=randomUUID(),monitor=randomUUID(),channel=randomUUID(),delivery=randomUUID(),id=randomUUID();
    const {encrypt}=await import("../server/dist/crypto.js");const key="a".repeat(64);
    db.prepare("INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)").run(user,"video@example.com","hash","{}");
    saveMonitor(db,{id:monitor,user_id:user,name:"Video",url:"https://example.com",kind:"browser",enabled:true,paused:false,next_run:new Date().toISOString()},user);
    db.prepare("INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)").run(channel,user,JSON.stringify({id:channel,user_id:user,name:"Telegram",provider:"telegram",enabled:true,config:{encrypted:encrypt(config,key)}}));
    const captures=[];
    for(const name of names.slice(0,2)){const captureId=randomUUID();captures.push(captureId);db.prepare("INSERT INTO captures(id,monitor_id,screenshot,created_at) VALUES(?,?,?,?)").run(captureId,monitor,name,Date.now());}
    const e={id,monitor_id:monitor,status:"changed",visual_changed:true,diff_screenshot:names[2],before_id:captures[0],after_id:captures[1],created_at:new Date().toISOString()};
    db.prepare("INSERT INTO events(id,monitor_id,before_id,after_id,status,payload,created_at) VALUES(?,?,?,?,?,?,?)").run(id,monitor,captures[0],captures[1],"changed",JSON.stringify(e),Date.now());
    db.prepare("INSERT INTO outbox(id,event_id,channel_id,next_attempt,payload) VALUES(?,?,?,?,?)").run(delivery,id,channel,Date.now(),"{}");
    let attempts=0;
    engine=new FusionEngine(db,{dataDir:dir,channelKey:key,browser:{close(){}},sendNotification:async(_provider,_configuration,details,store)=>{
      attempts++;await deliver("telegram",config,details,store,{telegram:async()=>{},videoEncoder:async()=>{if(attempts===1)throw Error("encode failed");return Buffer.from("fake-video");}});
    }});
    await engine.deliverPending();assert.equal(db.prepare("SELECT status FROM outbox WHERE id=?").get(delivery).status,"pending");
    db.prepare("UPDATE outbox SET next_attempt=? WHERE id=?").run(Date.now()-1,delivery);
    await engine.deliverPending();assert.equal(db.prepare("SELECT status FROM outbox WHERE id=?").get(delivery).status,"sent");assert.equal(attempts,2);
  } finally {engine?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});
