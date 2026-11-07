// Settings-only migration acceptance with 12 synthetic monitor configurations.
// Never connects to production PostgreSQL or prints secret material.
import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {hashSync,compareSync} from "bcryptjs";
import {openSimpleDatabase,getMonitor} from "./db.mjs";
import {encrypt,decrypt} from "../server/dist/crypto.js";
import {sealValues,openValues} from "../server/dist/vault.js";

test("real import CLI preserves 12 synthetic advanced monitors and decrypts all secrets",{timeout:30000},()=>{
  const root=mkdtempSync(path.join(tmpdir(),"simple-migration-"));
  try{
    const key="f".repeat(64),wrongKey="a".repeat(64),owner=randomUUID(),channel=randomUUID();
    const pass="Migration-Test-Password123!",password=hashSync(pass,4);
    const user={user_id:owner,email:"migrated@example.com",password,user_type:2,status:1,firstname:"Test",lastname:"Owner"};
    const monitors=Array.from({length:12},(_,i)=>({
      id:randomUUID(),user_id:owner,name:"Monitor "+(i+1),url:"https://example.com/?item="+i,
      kind:"browser",text_enabled:true,visual_enabled:i%2===0,
      selector:".result",selector_type:"css",capture_mode:i%2===0?"selected_area":"viewport",
      capture_area:i%2===0?{x:10,y:20,width:200,height:180}:null,
      capture_selector:"main",capture_selector_type:"css",
      browser_steps:i===0?[{action:"fill_private",selector:"input[name=q]",credential:"query",timeout_ms:5000,continue_on_error:false}]:[],
      interval_seconds:300+i*60,enabled:i!==9,paused:i===10,
      mobile_view:i%3===0&&i%2!==0,disable_javascript:i%3===1,
      block_ads_trackers:true,cookie_banner_handling:true,wait_before_capture_ms:2000,
      capture_timeout_ms:15000+i*1000,visual_threshold:"0.35",pixel_threshold:0.1,
      text_direction:i%2===0?"added":"both",ignore_text:["timestamp"],
      notification_enabled:true,notification_cooldown_seconds:300,notification_mode:i%4===0?"digest":"immediate",
      digest_window_seconds:3600,notify_failures:true,failure_alert_mode:"first_or_persistent",
      baseline_id:randomUUID(),latest_capture_id:randomUUID(),
      next_run:new Date(Date.now()+180000).toISOString(),created_at:new Date().toISOString()
    }));
    // Private browser steps operate only on HTTPS text-only monitors; the
    // first synthetic monitor uses different config for this secure test.
    monitors[0].visual_enabled=false;
    monitors[0].capture_mode="viewport";
    monitors[0].capture_area=null;
    const channelConfig={token:"123456:"+ "a".repeat(25),chat_id:"1234",timezone:"Europe/Istanbul"};
    const origin=new URL(monitors[0].url).origin;
    const vault={monitor_id:monitors[0].id,user_id:owner,origin,
      encrypted:sealValues({query:"private synthetic test secret"},key,monitors[0].id,owner,origin),
      value_names:["query"],expires_at:new Date(Date.now()+86400000).toISOString()};
    const bundle={format:"changd-fusion-pg-settings-v1",created_at:new Date().toISOString(),
      users:[user],monitors,
      channels:[{id:channel,user_id:owner,name:"Production-like Telegram",enabled:true,provider:"telegram",config:{encrypted:encrypt(channelConfig,key)}}],
      monitor_channels:monitors.map(m=>({monitor_id:m.id,channel_id:channel})),
      preferences:[{user_id:owner,monitoring_defaults:{interval_seconds:600,notification_enabled:true}}],
      access:[{public_enabled:true,owner_user_id:owner}],
      vault:[vault]};
    const source=path.join(root,"settings.json"),target=path.join(root,"data");
    mkdirSync(target,{mode:0o700});
    writeFileSync(source,JSON.stringify(bundle),{mode:0o600});
    const exec=(channelKey)=>spawnSync(process.execPath,["simple/import-settings.mjs"],{
      cwd:"/app",env:{...process.env,FUSION_IMPORT_FILE:source,FUSION_DATA_DIR:target,CHANNEL_KEY:channelKey},
      encoding:"utf8",timeout:10000
    });
    const rejected=exec(wrongKey);
    assert.notEqual(rejected.status,0,"wrong original key must be rejected");
    const imported=exec(key);
    assert.equal(imported.status,0,imported.stderr?.split("\n").slice(-3).join(" "));
    const summary=JSON.parse(imported.stdout.trim());
    assert.deepEqual([summary.users,summary.monitors,summary.channels,summary.vault],[1,12,1,1]);
    const db=openSimpleDatabase(path.join(target,"fusion.sqlite"));
    try{
      assert.equal(db.prepare("SELECT count(*) n FROM events").get().n,0);
      assert.equal(db.prepare("SELECT count(*) n FROM outbox").get().n,0);
      assert.equal(db.prepare("SELECT count(*) n FROM monitor_channels").get().n,12);
      assert.equal(db.prepare("SELECT value FROM metadata WHERE key='public_enabled'").get().value,"1");
      assert.equal(db.prepare("SELECT value FROM metadata WHERE key='public_owner'").get().value,owner);
      assert.equal(compareSync(pass,db.prepare("SELECT password_hash FROM users WHERE id=?").get(owner).password_hash),true);
      for(const original of monitors){
        const saved=getMonitor(db,original.id,owner);
        for(const field of ["id","name","url","kind","text_enabled","visual_enabled","selector","selector_type","capture_mode","capture_area","browser_steps","interval_seconds","enabled","paused","mobile_view","disable_javascript","block_ads_trackers","cookie_banner_handling","capture_timeout_ms","text_direction","notification_mode","notification_cooldown_seconds","failure_alert_mode"])
          assert.deepEqual(saved[field],original[field],"Setting mismatch "+field+" for "+original.name);
        assert.equal(saved.baseline_id,null,"Old baseline must be reset without notification");
      }
      const row=JSON.parse(db.prepare("SELECT payload FROM channels WHERE id=?").get(channel).payload);
      assert.deepEqual(decrypt(row.config.encrypted,key),channelConfig);
      const importedVault=JSON.parse(db.prepare("SELECT payload FROM vault WHERE monitor_id=?").get(monitors[0].id).payload);
      assert.deepEqual(openValues(importedVault,key,monitors[0]),{query:"private synthetic test secret"});
    }finally{db.close();}
    assert.notEqual(exec(key).status,0,"Second import must not overwrite an existing configuration");
  }finally{rmSync(root,{recursive:true,force:true});}
});
