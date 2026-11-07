import express from "express";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import { hash, compare } from "bcryptjs";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSimpleDatabase, getMonitor, listMonitors, saveMonitor, transaction, newId, userCount } from "./db.mjs";
import { FusionEngine } from "./engine.mjs";
import { EgressPolicy } from "../server/dist/egress.js";
import { previewRegion, releaseRegionPreviewSession, closeRegionPreviewSessions } from "../server/dist/region-picker.js";
import { previewJinaText } from "../server/dist/text-picker.js";
import { monitorInput as strictMonitorSchema } from "../server/dist/app.js";
import { z,ZodError } from "zod";
import { telegramSchema,smtpSchema,telegramSummary,telegramValidate,deliver } from "../server/dist/notifications.js";
import { encrypt,decrypt } from "../server/dist/crypto.js";
import { vaultSchema,sealValues } from "../server/dist/vault.js";
import { Storage } from "../server/dist/storage.js";

const DATA=process.env.FUSION_DATA_DIR??"/data";
if(!path.isAbsolute(DATA))throw Error("absolute_data_directory_required");
const PUBLIC_URL=process.env.PUBLIC_URL??"http://localhost:3000";
const PORT=Number(process.env.PORT??3000);
const SSL=new URL(PUBLIC_URL).protocol==="https:";
const db=openSimpleDatabase(path.join(DATA,"fusion.sqlite"));
const getMeta=k=>db.prepare("SELECT value FROM metadata WHERE key=?").get(k)?.value;
const setMeta=(k,v)=>db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(k,v);
const JWT_SECRET=getMeta("jwt_secret")??randomBytes(32).toString("hex");
const CHANNEL_KEY=getMeta("channel_key")??process.env.CHANNEL_KEY??randomBytes(32).toString("hex");
if(!getMeta("jwt_secret"))setMeta("jwt_secret",JWT_SECRET);
if(!getMeta("channel_key")){
  if(db.prepare("SELECT count(*) n FROM channels").get().n && !process.env.CHANNEL_KEY)
    throw Error("imported_channels_require_original_channel_key");
  setMeta("channel_key",CHANNEL_KEY);
}
const policy=new EgressPolicy(),engine=new FusionEngine(db,{dataDir:DATA,publicUrl:PUBLIC_URL,channelKey:CHANNEL_KEY});
const storage=new Storage(path.join(DATA,"artifacts"));
const cfg={NODE_ENV:"production",DATABASE_URL:"unused",JWT_SECRET,CHANNEL_KEY,PORT,PUBLIC_URL,DATA_DIR:DATA,
  REGISTRATION_ENABLED:"false",HISTORY_DAYS:90,CAPTURE_TIMEOUT_MS:30000,CHROMIUM_CONCURRENCY:1,
  PREVIEW_CAPACITY_WAIT_MS:12000,MAX_CAPTURE_WIDTH:4096,MAX_CAPTURE_HEIGHT:8192,
  MAX_CAPTURE_PIXELS:8000000,PLAYWRIGHT_EXECUTABLE_PATH:process.env.PLAYWRIGHT_EXECUTABLE_PATH??"/usr/bin/chromium",LOG_LEVEL:"warn"};
const app=express();
app.disable("x-powered-by");
app.set("trust proxy","loopback");
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:"256kb"}));
app.use(express.urlencoded({extended:false,limit:"8kb"}));
const api="/api/v1";
const safe=f=>async(req,res,next)=>{try{await f(req,res);}catch(error){next(error);}};
const now=()=>Date.now();
const sha=x=>createHash("sha256").update(x).digest("hex");
const cookie=(req,key)=>req.get("Cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith(key+"="))?.slice(key.length+1);
const authCookies={httpOnly:true,secure:SSL,sameSite:"strict",path:"/"};
const replyError=(status,message)=>Object.assign(new Error(message),{status});
const isUuid=x=>typeof x==="string"&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
const monitorDefaults={
  kind:"browser",text_enabled:true,visual_enabled:false,selector:"",selector_type:"css",
  ignore_selectors:[],ignore_text:[],mask_selectors:[],normalize_whitespace:true,ignore_case:false,
  visual_threshold:"0.35",pixel_threshold:0.1,interval_seconds:300,enabled:true,paused:false,
  text_direction:"both",text_source:"direct",extraction_mode:"full_text",keyword:null,extraction_rule:null,
  capture_mode:"viewport",capture_selector:"",capture_selector_type:"css",capture_area:null,
  browser_steps:[],step_budget_ms:20000,capture_timeout_ms:60000,monitor_http_error_pages:false,
  disable_javascript:false,block_ads_trackers:false,cookie_banner_handling:false,
  wait_before_capture_ms:0,mobile_view:false,notification_enabled:true,notify_failures:false,
  failure_alert_mode:"off",notify_attention:false,muted_until:null,notification_cooldown_seconds:0,
  notification_mode:"immediate",digest_window_seconds:3600
};
function monitorInput(input){
  return strictMonitorSchema.parse(input);
}
function channelPublic(c){
  const val=decrypt(c.config.encrypted,CHANNEL_KEY);
  const {password,token,...config}=val;
  return {id:c.id,name:c.name,provider:c.provider,enabled:c.enabled,config,test_required:!!(c.config.preview_test_required&&!c.config.preview_verified)};
}
function updateChannelLinks(monitorId,userId,channelIds){
  const unique=[...new Set(channelIds)];
  for(const id of unique){
    if(!isUuid(id)||!db.prepare("SELECT 1 FROM channels WHERE id=? AND user_id=?").get(id,userId))throw replyError(404,"Channel not found");
  }
  db.prepare("DELETE FROM monitor_channels WHERE monitor_id=?").run(monitorId);
  for(const id of unique)db.prepare("INSERT INTO monitor_channels(monitor_id,channel_id) VALUES(?,?)").run(monitorId,id);
}
function withChannels(m){
  return {...m,channel_ids:db.prepare("SELECT channel_id FROM monitor_channels WHERE monitor_id=?").all(m.id).map(x=>x.channel_id)};
}
function owner(req,id){
  if(!isUuid(id))throw replyError(404,"Monitor not found");
  const m=getMonitor(db,id,req.user.user_id);
  if(!m)throw replyError(404,"Monitor not found");
  return m;
}
function setSession(res,userId){
  const id=randomUUID(),refresh=randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(id,user_id,refresh_hash,expires_at,refresh_expires_at) VALUES(?,?,?,?,?)")
    .run(id,userId,sha(refresh),now()+900000,now()+2592000000);
  const token=jwt.sign({sub:userId,jti:id},JWT_SECRET,{algorithm:"HS256",issuer:"changd-fusion",audience:"changd-fusion-ui",expiresIn:"15m"});
  res.cookie("fusion_session",token,{...authCookies,maxAge:900000});
  res.cookie("fusion_refresh",refresh,{...authCookies,maxAge:2592000000});
  return id;
}
const TOKEN_FILE=path.join(DATA,"setup-token");
if(!userCount(db)&&!existsSync(TOKEN_FILE)){
  mkdirSync(DATA,{recursive:true,mode:0o700});
  writeFileSync(TOKEN_FILE,randomBytes(24).toString("hex")+"\n",{flag:"wx",mode:0o600});
}
app.get("/setup",(_req,res)=>{
  if(userCount(db))return res.redirect("/");
  res.setHeader("Cache-Control","no-store");
  res.type("html").send('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Changd Fusion Setup</title><main style="max-width:460px;margin:10vh auto;font:16px system-ui;padding:24px"><h1>Changd Fusion</h1><p>First administrator setup. Read the local setup token with <code>docker compose -f compose.simple.yml exec fusion cat /data/setup-token</code>.</p><form method="POST" action="/api/v1/setup"><p><label>Setup token <input name="token" required autocomplete="off"></label></p><p><label>Email <input type="email" name="email" required></label></p><p><label>Password <input type="password" name="password" required minlength="12"></label></p><button>Activate</button></form></main>');
});
app.get(api+"/setup-status",(_req,res)=>res.json({required:!userCount(db)}));
app.post(api+"/setup",safe(async(req,res)=>{
  if(userCount(db))throw replyError(409,"Already configured");
  const expected=readFileSync(TOKEN_FILE,"utf8").trim(),received=String(req.body?.token??"");
  if(expected.length!==received.length||!timingSafeEqual(Buffer.from(expected),Buffer.from(received)))throw replyError(403,"Invalid setup token");
  const email=String(req.body?.email??"").trim().toLowerCase(),password=String(req.body?.password??"");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12||Buffer.byteLength(password)>72)throw replyError(422,"Invalid credentials");
  if(userCount(db))throw replyError(409,"Already configured");
  const id=randomUUID(),pass=await hash(password,12);
  db.prepare("INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)").run(id,email,pass,JSON.stringify({user_id:id,email,firstname:"",lastname:"",user_type:2,status:1}));
  unlinkSync(TOKEN_FILE);
  setSession(res,id);
  if(req.is("application/json"))res.status(201).json({ok:true});
  else res.redirect(303,"/");
}));
app.get(api+"/health",(_req,res)=>res.json({status:"ok",version:"simple-preview",store:"sqlite",browser:engine.browser.status}));
app.use((req,res,next)=>{
  if(["POST","PUT","PATCH","DELETE"].includes(req.method) && req.path!==api+"/setup"){
    const origin=req.get("Origin");
    if(origin&&origin!==new URL(PUBLIC_URL).origin)return next(replyError(403,"Origin not permitted"));
    if(!req.get("X-Fusion-Request")&&req.path!==api+"/login"&&req.path!==api+"/session/refresh")return next(replyError(403,"Missing same-origin request marker"));
  }
  next();
});
app.post(api+"/login",safe(async(req,res)=>{
  const email=String(req.body?.email??"").toLowerCase().trim(),password=String(req.body?.password??"");
  const user=db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if(!user||!(await compare(password,user.password_hash)))throw replyError(401,"Invalid email or password");
  setSession(res,user.id);res.json({ok:true});
}));
app.post(api+"/session/refresh",safe(async(req,res)=>{
  const raw=cookie(req,"fusion_refresh"),session=raw?db.prepare("SELECT * FROM sessions WHERE refresh_hash=? AND refresh_expires_at>?").get(sha(raw),now()):null;
  if(!session)throw replyError(401,"Authentication required");
  db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
  setSession(res,session.user_id);res.json({ok:true});
}));
app.use(api,(req,res,next)=>{
  const token=cookie(req,"fusion_session");
  try{
    if(!token)throw Error("no-session");
    const decoded=jwt.verify(token,JWT_SECRET,{algorithms:["HS256"],issuer:"changd-fusion",audience:"changd-fusion-ui"});
    const session=db.prepare("SELECT * FROM sessions WHERE id=? AND user_id=? AND expires_at>?").get(decoded.jti,decoded.sub,now());
    if(!session)throw Error("expired-session");
    const record=db.prepare("SELECT * FROM users WHERE id=?").get(session.user_id);
    if(!record)throw Error("missing-user");
    const saved=JSON.parse(record.payload);
    if(saved.status===0)throw Error("inactive-account");
    req.user={user_id:record.id,email:record.email,firstname:saved.firstname??"",lastname:saved.lastname??"",user_type:saved.user_type??0};
    req.publicAccess=false;
    req.sessionId=session.id;
    return next();
  }catch{return res.status(401).json({error:"Authentication required"});}
});
app.get(api+"/users/me",(req,res)=>res.json({...req.user,public_access:!!req.publicAccess}));
// Protected account operations remain separate from ordinary workspace access.
const securityGrants=new Map();
function requireSecurity(req,res,next){
  const token=cookie(req,"fusion_security");
  const grant=token?securityGrants.get(sha(token)):undefined;
  if(!grant||grant.user!==req.user.user_id||grant.session!==req.sessionId||grant.expires<now())
    return res.status(403).json({error:"Account security verification required"});
  next();
}
app.get(api+"/users",requireSecurity,(req,res)=>{
  const records=db.prepare("SELECT id,email,payload FROM users ORDER BY email").all();
  res.json(records.map(row=>{const p=JSON.parse(row.payload);return {user_id:row.id,email:row.email,firstname:p.firstname??"",lastname:p.lastname??"",status:p.status??1};}));
});
app.post(api+"/security/verify",safe(async(req,res)=>{
  const email=String(req.body?.email??"").toLowerCase(),password=String(req.body?.password??"");
  const row=db.prepare("SELECT * FROM users WHERE id=?").get(req.user.user_id);
  if(!row||email!==row.email.toLowerCase()||!(await compare(password,row.password_hash)))
    throw replyError(401,"Invalid email or password");
  const token=randomBytes(32).toString("base64url");
  securityGrants.set(sha(token),{user:row.id,session:req.sessionId,expires:now()+600000});
  res.cookie("fusion_security",token,{...authCookies,maxAge:600000});res.json({ok:true});
}));
app.post(api+"/security/leave",(req,res)=>{
  const token=cookie(req,"fusion_security");if(token)securityGrants.delete(sha(token));
  res.clearCookie("fusion_security",{path:"/"});res.json({ok:true});
});
app.post(api+"/users/changepassword",requireSecurity,safe(async(req,res)=>{
  const value=req.body?.password;
  if(typeof value!=="string"||value.length<12||value.length>72||Buffer.byteLength(value,"utf8")>72)
    throw replyError(422,"Invalid new password");
  const record=db.prepare("SELECT payload FROM users WHERE id=?").get(req.user.user_id);
  const payload=JSON.parse(record.payload);
  delete payload.password;
  const updatedHash=await hash(value,12);
  transaction(db,()=>{
    db.prepare("UPDATE users SET password_hash=?,payload=? WHERE id=?")
      .run(updatedHash,JSON.stringify(payload),req.user.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.user_id);
  });
  res.clearCookie("fusion_session",{path:"/"});res.clearCookie("fusion_refresh",{path:"/"});
  res.clearCookie("fusion_security",{path:"/"});res.json({ok:true});
}));
app.post(api+"/logout-all",requireSecurity,(req,res)=>{
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.user_id);
  res.clearCookie("fusion_session",{path:"/"});res.clearCookie("fusion_refresh",{path:"/"});
  res.clearCookie("fusion_security",{path:"/"});res.json({ok:true});
});
app.get(api+"/account/public-access",requireSecurity,(req,res)=>res.json({public_enabled:false,owner_user_id:null}));
app.put(api+"/account/public-access",requireSecurity,(_req,res)=>res.status(501).json({error:"Public workspace mode is not yet supported in Simple preview"}));
app.post(api+"/logout",(req,res)=>{
  db.prepare("DELETE FROM sessions WHERE id=?").run(req.sessionId);
  res.clearCookie("fusion_session",{path:"/"});res.clearCookie("fusion_refresh",{path:"/"});res.json({ok:true});
});
app.post(api+"/monitors/notification-channels/bulk",safe(async(req,res)=>{
  const body=z.object({monitor_ids:z.array(z.string().uuid()).min(1).max(100),channel_id:z.string().uuid(),action:z.enum(["add","remove"]),confirm:z.literal(true)}).strict().parse(req.body);
  transaction(db,()=>{
    if(!db.prepare("SELECT 1 FROM channels WHERE id=? AND user_id=?").get(body.channel_id,req.user.user_id))
      throw replyError(404,"Channel not found");
    const monitorIds=[...new Set(body.monitor_ids)];
    for(const id of monitorIds){
      if(!db.prepare("SELECT 1 FROM monitors WHERE id=? AND user_id=?").get(id,req.user.user_id))
        throw replyError(404,"Monitor not found");
    }
    for(const id of monitorIds) {
      if(body.action==="add")
        db.prepare("INSERT OR IGNORE INTO monitor_channels(monitor_id,channel_id) VALUES(?,?)").run(id,body.channel_id);
      else db.prepare("DELETE FROM monitor_channels WHERE monitor_id=? AND channel_id=?").run(id,body.channel_id);
    }
  });
  res.status(204).end();
}));
app.get(api+"/jobs",(req,res)=>res.json(listMonitors(db,req.user.user_id).map(withChannels)));
app.post(api+"/jobs",safe(async(req,res)=>{
  const input=monitorInput(req.body);
  await policy.target(input.url);
  const id=randomUUID(),{channel_ids=[],...config}=input;
  const m={...config,id,user_id:req.user.user_id,created_at:new Date().toISOString(),monitor_state:"waiting_baseline",baseline_id:null,latest_capture_id:null};
  transaction(db,()=>{saveMonitor(db,m,req.user.user_id);updateChannelLinks(id,req.user.user_id,channel_ids);});
  res.status(201).json(withChannels(getMonitor(db,id,req.user.user_id)));
}));
app.get(api+"/jobs/:id",safe(async(req,res)=>res.json(withChannels(owner(req,req.params.id)))));
app.put(api+"/jobs/:id",safe(async(req,res)=>{
  const old=owner(req,req.params.id),input=monitorInput(req.body);
  await policy.target(input.url);
  const {channel_ids=[],...config}=input;
  const noReset=new Set(["name","interval_seconds","enabled","paused","notify_failures","failure_alert_mode","notify_attention","notification_enabled","muted_until","notification_cooldown_seconds","notification_mode","digest_window_seconds","visual_threshold","pixel_threshold","step_budget_ms","capture_timeout_ms","text_direction"]);
  const changed=Object.entries(config).some(([key,val])=>!noReset.has(key)&&JSON.stringify(old[key])!==JSON.stringify(val));
  const m={...old,...config,monitor_state:changed?"waiting_baseline":old.monitor_state,baseline_id:changed?null:old.baseline_id,latest_capture_id:changed?null:old.latest_capture_id,next_run:new Date().toISOString()};
  transaction(db,()=>{
    saveMonitor(db,m,req.user.user_id,{replace:true});
    updateChannelLinks(m.id,req.user.user_id,channel_ids);
    if(new URL(old.url).origin!==new URL(m.url).origin)db.prepare("DELETE FROM vault WHERE monitor_id=?").run(m.id);
  });
  res.json(withChannels(getMonitor(db,m.id,req.user.user_id)));
}));
app.delete(api+"/jobs/:id",safe(async(req,res)=>{
  const m=owner(req,req.params.id);
  if(engine.browser.status.capture)throw replyError(409,"Capture running; retry after completion");
  db.prepare("DELETE FROM monitors WHERE id=? AND user_id=?").run(m.id,m.user_id);
  res.json({ok:true});
}));
app.post(api+"/jobs/:id/reset",safe(async(req,res)=>{
  const m=owner(req,req.params.id);
  m.baseline_id=null;m.latest_capture_id=null;m.monitor_state="waiting_baseline";m.next_run=new Date().toISOString();
  saveMonitor(db,m,m.user_id,{replace:true});res.json({ok:true});
}));
app.post(api+"/jobs/:id/run",safe(async(req,res)=>{
  const m=owner(req,req.params.id);
  const run=engine.enqueue(m.id,m.user_id);
  res.status(202).json({queued:run.status==="queued",running:run.status==="running",status:run.status,request_id:run.id});
}));
app.get(api+"/jobs/:id/run",safe(async(req,res)=>{
  const m=owner(req,req.params.id);res.json(engine.manualFor(m.id,m.user_id));
}));
app.delete(api+"/jobs/:id/run",safe(async(req,res)=>{
  const m=owner(req,req.params.id);
  if(!engine.cancelManual(m.id,m.user_id)&&engine.manualFor(m.id,m.user_id).status==="running")throw replyError(409,"Check is running");
  res.status(204).end();
}));
app.get(api+"/jobs/:id/history",safe(async(req,res)=>{
  const m=owner(req,req.params.id),page=Math.max(1,Math.min(100000,Number(req.query.page)||1)),size=Math.max(1,Math.min(100,Number(req.query.page_size)||20));
  const status=typeof req.query.status==="string"?req.query.status:null;
  const rows=db.prepare("SELECT e.*,b.screenshot before_image,a.screenshot after_image FROM events e LEFT JOIN captures b ON b.id=e.before_id LEFT JOIN captures a ON a.id=e.after_id WHERE e.monitor_id=? AND (? IS NULL OR e.status=?) ORDER BY e.created_at DESC LIMIT ? OFFSET ?").all(m.id,status,status,req.query.page===undefined?100:size,req.query.page===undefined?0:(page-1)*size);
  const deliveryRows=db.prepare("SELECT o.*,json_extract(c.payload,'$.name') channel_name FROM outbox o JOIN channels c ON c.id=o.channel_id WHERE o.event_id=? ORDER BY o.next_attempt DESC");
  const items=rows.map(row=>({...JSON.parse(row.payload),before_image:row.before_image,after_image:row.after_image,
    deliveries:deliveryRows.all(row.id).map(d=>({id:d.id,channel_id:d.channel_id,channel_name:d.channel_name,attempts:d.attempts,status:d.status,next_attempt:new Date(d.next_attempt).toISOString(),...JSON.parse(d.payload)}))}));
  if(req.query.page===undefined)return res.json(items);
  const count=db.prepare("SELECT count(*) n FROM events WHERE monitor_id=? AND (? IS NULL OR status=?)").get(m.id,status,status).n;
  res.json({items,total:count,page,page_size:size});
}));
app.get(api+"/screenshots/:name",safe(async(req,res)=>{
  const name=req.params.name;
  if(!/^[a-f0-9-]{36}\.png$/.test(name))throw replyError(404,"Not found");
  const allowed=db.prepare("SELECT 1 FROM captures c JOIN monitors m ON m.id=c.monitor_id WHERE m.user_id=? AND c.screenshot=? UNION SELECT 1 FROM events e JOIN monitors m ON m.id=e.monitor_id WHERE m.user_id=? AND json_extract(e.payload,'$.diff_screenshot')=? LIMIT 1").get(req.user.user_id,name,req.user.user_id,name);
  if(!allowed)throw replyError(404,"Not found");
  res.setHeader("Cache-Control","private,no-store");res.sendFile(await storage.file(name));
}));
app.get(api+"/preferences/monitoring",(req,res)=>{
  const row=db.prepare("SELECT payload FROM preferences WHERE user_id=?").get(req.user.user_id);
  res.json(row?JSON.parse(row.payload):{});
});
app.put(api+"/preferences/monitoring",(req,res)=>{
  const value=req.body??{};
  if(typeof value!=="object"||Array.isArray(value))throw replyError(422,"Invalid preferences");
  db.prepare("INSERT INTO preferences(user_id,payload) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload").run(req.user.user_id,JSON.stringify(value));
  res.json(value);
});
app.get(api+"/notifications",(req,res)=>{
  const rows=db.prepare("SELECT payload FROM channels WHERE user_id=?").all(req.user.user_id);
  res.json(rows.map(row=>channelPublic(JSON.parse(row.payload))));
});
app.post(api+"/notifications",safe(async(req,res)=>{
  const {name,provider,config,enabled=true}=req.body??{};
  if(typeof name!=="string"||name.length<1||name.length>100||!["smtp","telegram"].includes(provider))throw replyError(422,"Invalid channel");
  const val=(provider==="smtp"?smtpSchema:telegramSchema).parse(config);
  const id=randomUUID(),channel={id,user_id:req.user.user_id,name,provider,enabled:!!enabled,config:{encrypted:encrypt(val,CHANNEL_KEY)}};
  db.prepare("INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)").run(id,req.user.user_id,JSON.stringify(channel));
  res.status(201).json(channelPublic(channel));
}));
app.put(api+"/notifications/:id",safe(async(req,res)=>{
  const row=db.prepare("SELECT payload FROM channels WHERE id=? AND user_id=?").get(req.params.id,req.user.user_id);
  if(!row)throw replyError(404,"Channel not found");
  const old=JSON.parse(row.payload),body=req.body??{},name=String(body.name??"");
  if(!["smtp","telegram"].includes(body.provider)||!name||name.length>100)throw replyError(422,"Invalid channel");
  const previous=decrypt(old.config.encrypted,CHANNEL_KEY),incoming={...body.config};
  if(body.provider===old.provider){
    if(body.provider==="telegram"&&!incoming.token)incoming.token=previous.token;
    if(body.provider==="smtp"&&!incoming.password)incoming.password=previous.password;
  }
  const val=(body.provider==="smtp"?smtpSchema:telegramSchema).parse(incoming);
  const channel={...old,name,provider:body.provider,enabled:body.enabled!==false,config:{encrypted:encrypt(val,CHANNEL_KEY)}};
  db.prepare("UPDATE channels SET payload=? WHERE id=?").run(JSON.stringify(channel),old.id);res.json(channelPublic(channel));
}));
app.delete(api+"/notifications/:id",(req,res)=>{
  db.prepare("DELETE FROM channels WHERE id=? AND user_id=?").run(req.params.id,req.user.user_id);res.json({ok:true});
});
app.get(api+"/notifications/preview/:kind",(req,res)=>{
  res.json({text:telegramSummary({id:"example",name:"Example monitor",monitorId:"example",
    textChanged:true,visualChanged:false,textSummary:"Content changed",percent:"0",images:[],
    link:PUBLIC_URL,checkedAt:new Date().toISOString()}, "UTC")});
});
app.get(api+"/jobs/:id/private-values",safe(async(req,res)=>{
  const m=owner(req,req.params.id),row=db.prepare("SELECT payload FROM vault WHERE monitor_id=? AND user_id=?").get(m.id,m.user_id);
  res.setHeader("Cache-Control","private,no-store");
  const v=row?JSON.parse(row.payload):null;
  res.json(v?{value_names:v.value_names,expires_at:v.expires_at,updated_at:v.updated_at}:{value_names:[]});
}));
app.put(api+"/jobs/:id/private-values",safe(async(req,res)=>{
  const m=owner(req,req.params.id),body=vaultSchema.parse(req.body);
  if(m.kind!=="browser"||m.visual_enabled||new URL(m.url).protocol!=="https:")throw replyError(422,"Private values require HTTPS text-only Browser monitor");
  await policy.target(m.url);
  const origin=new URL(m.url).origin;
  const vault={monitor_id:m.id,user_id:m.user_id,origin,encrypted:sealValues(body.values,CHANNEL_KEY,m.id,m.user_id,origin),value_names:Object.keys(body.values),expires_at:body.expires_at,updated_at:new Date().toISOString()};
  transaction(db,()=>{
    db.prepare("INSERT INTO vault(monitor_id,user_id,payload) VALUES(?,?,?) ON CONFLICT(monitor_id) DO UPDATE SET payload=excluded.payload").run(m.id,m.user_id,JSON.stringify(vault));
    m.baseline_id=null;m.monitor_state="waiting_baseline";m.next_run=new Date().toISOString();
    saveMonitor(db,m,m.user_id,{replace:true});
  });
  res.json({ok:true});
}));
app.delete(api+"/jobs/:id/private-values",safe(async(req,res)=>{
  const m=owner(req,req.params.id);db.prepare("DELETE FROM vault WHERE monitor_id=? AND user_id=?").run(m.id,m.user_id);res.json({ok:true});
}));
const previewProgress=new Map();
async function handleSimplePreview(req,res,monitor,body,options={}){
  await policy.target(monitor.url);
  const cancellation=new AbortController();
  const onClose=()=>{if(!res.writableEnded)cancellation.abort();};
  req.once("aborted",onClose);res.once("close",onClose);
  const rid=body.preview_request_id;
  try {
    const result=await previewRegion(monitor,cfg,body.point,policy,{
      ownerId:req.user.user_id,id:body.session_id,retain:options.retain!==false,
      captureLayout:body.mode!=="area",refresh:!!body.refresh,scrollDeltaY:body.scroll_delta_y,
      signal:cancellation.signal,
      progress:stage=>{if(isUuid(rid))previewProgress.set(rid,{ownerId:req.user.user_id,stage,at:Date.now()});},
      acquireCapacity:async (_onWait,waitMs)=>engine.browser.acquirePreview({signal:cancellation.signal,waitMs:Math.min(12000,waitMs)})
    });
    if(isUuid(rid))previewProgress.set(rid,{ownerId:req.user.user_id,stage:"ready",at:Date.now()});
    res.json(result);
  } catch(error) {
    if(error && Number.isInteger(error.status) && typeof error.failure_code==="string")
      return res.status(error.status).json({error:error.message,preview_stage:error.stage,failure_code:error.failure_code,...(error.step?{step:error.step,action:error.action}:{})});
    throw error;
  } finally {req.off("aborted",onClose);res.off("close",onClose);}
}
app.post(api+"/region-preview",safe(async(req,res)=>{
  const body=req.body??{};
  if(body.monitor_id)owner(req,body.monitor_id);
  const monitor={...monitorDefaults,...body.monitor,id:body.monitor_id??"preview",kind:"browser",visual_enabled:true};
  await handleSimplePreview(req,res,monitor,body);
}));
app.post(api+"/jobs/:id/region-preview",safe(async(req,res)=>{
  const monitor=owner(req,req.params.id);
  const point=Object.keys(req.body??{}).length?z.object({x:z.number().finite(),y:z.number().finite()}).strict().parse(req.body):undefined;
  await handleSimplePreview(req,res,{...monitor,kind:"browser",visual_enabled:true},{point},{retain:false});
}));
app.get(api+"/region-preview/status/:id",(req,res)=>{
  const p=previewProgress.get(req.params.id);
  if(!p||p.ownerId!==req.user.user_id||now()-p.at>120000)throw replyError(404,"Not found");
  res.json({stage:p.stage});
});
app.delete(api+"/region-preview/:id",safe(async(req,res)=>{
  await releaseRegionPreviewSession(req.user.user_id,req.params.id);res.status(204).end();
}));
app.post(api+"/interactive-presence",(req,res)=>res.json({id:isUuid(req.body?.id)?req.body.id:randomUUID(),expires_in_ms:20000}));
app.delete(api+"/interactive-presence/:id",(_req,res)=>res.status(204).end());
app.post(api+"/text-preview",safe(async(req,res)=>{
  const b=req.body??{};
  if(b.monitor_id)owner(req,b.monitor_id);
  res.json(await previewJinaText({ownerId:req.user.user_id,url:b.url,sessionId:b.session_id,lineIndex:b.line_index,selectedValue:b.selected_value,query:b.query,offset:b.offset,limit:b.limit},cfg,policy));
}));
app.get(api+"/system/diagnostics",(req,res)=>{
  const count=db.prepare("SELECT count(*) total,sum(CASE WHEN enabled=1 AND paused=0 AND last_status NOT IN ('persistent_failure','authentication_required','challenge_detected') THEN 1 ELSE 0 END) active,sum(CASE WHEN last_status IN ('persistent_failure','authentication_required','challenge_detected') THEN 1 ELSE 0 END) attention FROM monitors WHERE user_id=?").get(req.user.user_id);
  const delivery=db.prepare("SELECT sum(CASE WHEN o.status='pending' THEN 1 ELSE 0 END) pending,sum(CASE WHEN o.status='failed' THEN 1 ELSE 0 END) failed FROM outbox o JOIN channels c ON c.id=o.channel_id JOIN events e ON e.id=o.event_id JOIN monitors m ON m.id=e.monitor_id WHERE m.user_id=? AND c.user_id=?").get(req.user.user_id,req.user.user_id);
  res.json({api:"ok",monitoring:{total:count.total,active:count.active??0,attention:count.attention??0},deliveries:{pending:delivery.pending??0,failed:delivery.failed??0},retention_days:90});
});
const eventStatus=z.enum(["baseline","unchanged","changed","failed","reset","legacy","test","digest","extraction_transition"]);
const eventFilters=z.object({
  monitor_id:z.string().uuid().optional(),status:eventStatus.optional(),
  from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional()
}).strict().refine(q=>!q.from||!q.to||Date.parse(q.from)<=Date.parse(q.to),{message:"Start date must precede end date"});
function scopedEvents(query,userId){
  const where="WHERE m.user_id=? AND (? IS NULL OR e.monitor_id=?) AND (? IS NULL OR e.status=?) AND (? IS NULL OR e.created_at>=?) AND (? IS NULL OR e.created_at<=?)";
  const params=[userId,query.monitor_id??null,query.monitor_id??null,query.status??null,query.status??null,
    query.from?Date.parse(query.from):null,query.from?Date.parse(query.from):null,
    query.to?Date.parse(query.to):null,query.to?Date.parse(query.to):null];
  return {where,params};
}
app.get(api+"/timeline",safe(async(req,res)=>{
  const query=eventFilters.extend({page:z.coerce.number().int().min(1).max(100000).default(1),page_size:z.coerce.number().int().min(1).max(100).default(25)})
    .refine(q=>!q.from||!q.to||Date.parse(q.from)<=Date.parse(q.to),{message:"Start date must precede end date"}).parse(req.query);
  const {where,params}=scopedEvents(query,req.user.user_id);
  const joined="FROM events e JOIN monitors m ON m.id=e.monitor_id ";
  const rows=db.prepare("SELECT e.id,e.monitor_id,e.status,e.payload,e.created_at,json_extract(m.payload,'$.name') monitor_name "+joined+where+" ORDER BY e.created_at DESC,e.id DESC LIMIT ? OFFSET ?").all(...params,query.page_size,(query.page-1)*query.page_size);
  const total=db.prepare("SELECT count(*) n "+joined+where).get(...params).n;
  const items=rows.map(row=>{
    const e=JSON.parse(row.payload),diff=e.text_diff??[];
    return {...e,id:row.id,monitor_id:row.monitor_id,monitor_name:row.monitor_name,status:row.status,
      created_at:new Date(row.created_at).toISOString(),
      text_added:diff.some(part=>part.added===true),text_removed:diff.some(part=>part.removed===true)};
  });
  res.json({items,total,page:query.page,page_size:query.page_size});
}));
app.get(api+"/analytics",safe(async(req,res)=>{
  const query=eventFilters.parse(req.query),{where,params}=scopedEvents(query,req.user.user_id);
  const joined="FROM events e JOIN monitors m ON m.id=e.monitor_id ";
  const rows=db.prepare("SELECT e.status,count(*) n "+joined+where+" GROUP BY e.status ORDER BY n DESC,e.status ASC").all(...params);
  const total=rows.reduce((n,r)=>n+r.n,0),changed=rows.find(r=>r.status==="changed")?.n??0,failed=rows.find(r=>r.status==="failed")?.n??0;
  const successful=rows.filter(r=>["baseline","unchanged","changed","extraction_transition"].includes(r.status)).reduce((n,r)=>n+r.n,0);
  const trend=db.prepare("SELECT strftime('%Y-%m-%d',e.created_at/1000,'unixepoch') day,count(*) total,sum(CASE WHEN e.status='changed' THEN 1 ELSE 0 END) changed,sum(CASE WHEN e.status='failed' THEN 1 ELSE 0 END) failed,sum(CASE WHEN e.status IN ('baseline','unchanged','changed','extraction_transition') THEN 1 ELSE 0 END) successful "+joined+where+" GROUP BY day ORDER BY day ASC").all(...params);
  res.json({summary:{total,changed,failed,successful},distribution:rows.map(r=>({status:r.status,count:r.n})),trend});
}));
app.get(api+"/deliveries",safe(async(req,res)=>{
  const query=z.object({
    page:z.coerce.number().int().min(1).max(100000).default(1),
    page_size:z.coerce.number().int().min(1).max(100).default(20),
    status:z.enum(["pending","retrying","sending","sent","failed"]).optional()
  }).strict().parse(req.query);
  const from="FROM outbox o JOIN channels c ON c.id=o.channel_id JOIN events e ON e.id=o.event_id JOIN monitors m ON m.id=e.monitor_id";
  const status="CASE WHEN o.status='pending' AND o.attempts>0 THEN 'retrying' ELSE o.status END";
  const where="WHERE c.user_id=? AND m.user_id=? AND (? IS NULL OR "+status+"=?)";
  const params=[req.user.user_id,req.user.user_id,query.status??null,query.status??null];
  const rows=db.prepare("SELECT o.*,json_extract(c.payload,'$.name') channel_name,m.id monitor_id,json_extract(m.payload,'$.name') monitor_name,"+status+" display_status "+from+" "+where+" ORDER BY o.next_attempt DESC,o.id DESC LIMIT ? OFFSET ?").all(...params,query.page_size,(query.page-1)*query.page_size);
  const total=db.prepare("SELECT count(*) n "+from+" "+where).get(...params).n;
  res.json({items:rows.map(row=>({
    id:row.id,event_id:row.event_id,channel_id:row.channel_id,channel_name:row.channel_name,monitor_id:row.monitor_id,monitor_name:row.monitor_name,
    attempts:row.attempts,status:row.display_status,next_attempt:new Date(row.next_attempt).toISOString(),
    delivered_at:JSON.parse(row.payload).delivered_at??null,last_error:JSON.parse(row.payload).last_error??null
  })),total,page:query.page,page_size:query.page_size});
}));
app.post(api+"/deliveries/:id/retry",safe(async(req,res)=>{
  if(!isUuid(req.params.id))throw replyError(404,"Failed delivery not found");
  if(req.user.user_type!==2)throw replyError(403,"Administrator required");
  const row=db.prepare("SELECT o.* FROM outbox o JOIN channels c ON c.id=o.channel_id JOIN events e ON e.id=o.event_id JOIN monitors m ON m.id=e.monitor_id WHERE o.id=? AND o.status='failed' AND c.enabled=1 AND c.user_id=? AND m.user_id=?").get(req.params.id,req.user.user_id,req.user.user_id);
  if(!row)throw replyError(404,"Failed delivery not found");
  const payload={...JSON.parse(row.payload),last_error:null};
  const updated=db.prepare("UPDATE outbox SET status='pending',attempts=0,next_attempt=?,payload=? WHERE id=? AND status='failed'").run(Date.now(),JSON.stringify(payload),row.id);
  if(!updated.changes)throw replyError(409,"Delivery is no longer failed");
  setImmediate(()=>void engine.deliverPending().catch(()=>{}));
  res.status(202).json({queued:true});
}));
app.post(api+"/notifications/:id/test",safe(async(req,res)=>{
  const channel=db.prepare("SELECT payload FROM channels WHERE id=? AND user_id=?").get(req.params.id,req.user.user_id);
  if(!channel)throw replyError(404,"Channel not found");
  const {monitor_id}=z.object({monitor_id:z.string().uuid()}).strict().parse(req.body);
  const monitor=owner(req,monitor_id),eventId=randomUUID(),createdAt=Date.now();
  const event={id:eventId,monitor_id:monitor.id,status:"test",text_changed:true,visual_changed:false,text_diff:[{value:"Test notification",added:true,removed:false}],created_at:new Date(createdAt).toISOString()};
  transaction(db,()=>{
    db.prepare("INSERT INTO events(id,monitor_id,status,payload,created_at) VALUES(?,?,?,?,?)")
      .run(eventId,monitor.id,"test",JSON.stringify(event),createdAt);
    db.prepare("INSERT INTO outbox(id,event_id,channel_id,next_attempt,payload) VALUES(?,?,?,?,?)")
      .run(randomUUID(),eventId,req.params.id,createdAt,JSON.stringify({eventId}));
  });
  setImmediate(()=>void engine.deliverPending().catch(()=>{}));
  res.status(202).json({queued:true});
}));
app.post(api+"/notifications/:id/validate",safe(async(req,res)=>{
  const row=db.prepare("SELECT payload FROM channels WHERE id=? AND user_id=?").get(req.params.id,req.user.user_id);
  if(!row)throw replyError(404,"Channel not found");
  const channel=JSON.parse(row.payload);
  if(channel.provider!=="telegram")throw replyError(400,"Telegram channel required");
  const config=telegramSchema.parse(decrypt(channel.config.encrypted,CHANNEL_KEY));
  try{res.json({valid:true,bot:await telegramValidate(config.token)});}
  catch{throw replyError(400,"Telegram bot validation failed");}
}));
app.use(api,(_req,res)=>res.status(404).json({error:"Unsupported API endpoint in simple preview"}));
const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../frontend/dist");
app.use(express.static(frontend,{index:false,fallthrough:true}));
app.get("/{*path}",(req,res)=>{
  if(!userCount(db))return res.redirect("/setup");
  res.sendFile(path.join(frontend,"index.html"));
});
app.use((error,req,res,_next)=>{
  const status=error instanceof ZodError?422:Number.isInteger(error.status)?error.status:500;
  if(status>=500)console.error(JSON.stringify({code:"simple_api_error",route:req.path,status}));
  res.status(status).json({error:status>=500?"Internal server error":status===422?"Invalid request":error.message??"Request rejected"});
});
const server=app.listen(PORT,"0.0.0.0",()=>{
  console.log(JSON.stringify({status:"ready",port:PORT,database:"sqlite",users:userCount(db),mode:"single-container"}));
});
engine.start();
setInterval(()=>void engine.deliverPending().catch(()=>{}),30000).unref();
let exiting=false;
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>{
  if(exiting)return;exiting=true;
  engine.close();
  void closeRegionPreviewSessions().catch(()=>{}).finally(()=>{
    server.close(()=>{try{db.close();}finally{process.exit(0);}});
  });
});
