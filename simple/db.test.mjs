import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openSimpleDatabase, importConfiguration, getMonitor, transaction, saveMonitor } from "./db.mjs";

function fixture(){
  const user=randomUUID(),monitor=randomUUID(),channel=randomUUID(),vault={monitor_id:monitor,user_id:user,origin:"https://example.com",encrypted:"encrypted-secret",value_names:["field"],expires_at:new Date().toISOString()};
  return { format:"changd-fusion-pg-settings-v1",
    users:[{user_id:user,email:"example@example.com",password:"$2b$12$abcdefghijklmnopqrstuvwxyz1234567890ABCDEFghiijk",status:1,user_type:2}],
    monitors:[{id:monitor,user_id:user,name:"Example",url:"https://example.com",kind:"browser",text_enabled:true,visual_enabled:true,selector:".price",browser_steps:[{action:"scroll",delta_y:100}],capture_mode:"element",capture_selector:".price",interval_seconds:300,paused:false,enabled:true,disable_javascript:true,notification_mode:"immediate",next_run:new Date().toISOString(),baseline_id:randomUUID()}],
    channels:[{id:channel,user_id:user,provider:"telegram",name:"Alerts",enabled:true,config:{encrypted:"encrypted-secret"}}],
    monitor_channels:[{monitor_id:monitor,channel_id:channel}],
    preferences:[{user_id:user,monitoring_defaults:{capture_timeout_ms:60000}}],
    vault:[vault]};
}

test("settings-only import preserves IDs, credentials, advanced monitor configuration and links",()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"fusion-simple-db-"));
  try {
    const db=openSimpleDatabase(path.join(dir,"fusion.sqlite")), bundle=fixture();
    assert.deepEqual(importConfiguration(db,bundle),{users:1,monitors:1,channels:1,vault:1});
    const m=getMonitor(db,bundle.monitors[0].id,bundle.users[0].user_id);
    assert.deepEqual(m.browser_steps,bundle.monitors[0].browser_steps);
    assert.equal(m.disable_javascript,true);
    assert.equal(m.capture_mode,"element");
    assert.equal(m.baseline_id,null);
    assert.equal(db.prepare("SELECT password_hash FROM users").get().password_hash,bundle.users[0].password);
    assert.equal(JSON.parse(db.prepare("SELECT payload FROM channels").get().payload).config.encrypted,"encrypted-secret");
    assert.equal(db.prepare("SELECT count(*) n FROM monitor_channels").get().n,1);
    assert.equal(db.prepare("SELECT count(*) n FROM vault").get().n,1);
    assert.throws(()=>importConfiguration(db,bundle),/empty_database/);
    db.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("invalid channel ownership rolls back every table, no partial configuration loss",()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"fusion-simple-db-"));
  try {
    const db=openSimpleDatabase(path.join(dir,"fusion.sqlite")), bundle=fixture();
    bundle.monitor_channels[0].channel_id=randomUUID();
    assert.throws(()=>importConfiguration(db,bundle),/invalid_imported_channel_link/);
    for(const table of ["users","monitors","channels","preferences","vault","monitor_channels"])
      assert.equal(db.prepare("SELECT count(*) n FROM "+table).get().n,0);
    db.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("SQLite transactions roll back and preserve original settings on failed update",()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"fusion-simple-db-"));
  try {
    const db=openSimpleDatabase(path.join(dir,"fusion.sqlite")), bundle=fixture();
    importConfiguration(db,bundle);
    const m=getMonitor(db,bundle.monitors[0].id,bundle.users[0].user_id);
    assert.throws(()=>transaction(db,()=>{
      saveMonitor(db,{...m,name:"Changed"},m.user_id,{replace:true});
      throw Error("synthetic-failure");
    }),/synthetic-failure/);
    assert.equal(getMonitor(db,m.id,m.user_id).name,"Example");
    db.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
