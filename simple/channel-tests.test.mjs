import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSimpleDatabase, saveMonitor } from './db.mjs';
import { queueChannelTest } from './channel-tests.mjs';
import { listDeliveries, retryDelivery } from './deliveries.mjs';
import { FusionEngine } from './engine.mjs';
import { encrypt } from '../server/dist/crypto.js';
import { SmtpAcceptanceError } from '../server/dist/notifications.js';

test('channel tests use no monitor/event and join Delivery History with owner-scoped retry',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'fusion-channel-tests-'));let db,engine;
  try{
    db=openSimpleDatabase(path.join(dir,'fusion.sqlite'));
    const owner=randomUUID(),other=randomUUID(),smtpId=randomUUID(),telegramId=randomUUID(),key='a'.repeat(64);
    for(const [id,email] of [[owner,'owner@example.com'],[other,'other@example.com']])
      db.prepare('INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)').run(id,email,'hash','{}');
    const channel=(id,provider,configuration,extra={})=>({id,user_id:owner,name:provider,provider,enabled:true,
      config:{encrypted:encrypt(configuration,key),...extra}});
    db.prepare('INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)').run(smtpId,owner,JSON.stringify(channel(smtpId,'smtp',{host:'mail.example.com',port:465,from:'sender@example.com',to:'receiver@example.com'})));
    db.prepare('INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)').run(telegramId,owner,JSON.stringify(channel(telegramId,'telegram',{token:'123456:'+'a'.repeat(25),chat_id:'1234',timezone:'UTC'},{preview_test_required:true,preview_verified:false})));
    assert.equal(queueChannelTest(db,smtpId,other),null);
    const smtpTest=queueChannelTest(db,smtpId,owner),telegramTest=queueChannelTest(db,telegramId,owner);
    assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM monitors').get().n,0);
    const sent=[];
    engine=new FusionEngine(db,{dataDir:dir,publicUrl:'https://fusion.example.com',channelKey:key,browser:{close(){}},
      sendNotification:async(provider,_configuration,details)=>{
        sent.push({provider,details});
        if(provider==='smtp')return {smtp:{status:'accepted_by_smtp',response_code:'250',message_id_sha256:'b'.repeat(64)}};
      }});
    await engine.deliverPending();
    assert.equal(sent.length,2);
    assert.ok(sent.every(item=>item.details.monitorId===''&&item.details.eventType==='test'));
    assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM outbox').get().n,0);
    const history=listDeliveries(db,owner);
    assert.equal(history.total,2);
    assert.ok(history.items.every(item=>item.kind==='test'&&item.monitor_id===null));
    assert.equal(history.items.find(item=>item.id===smtpTest).smtp_result.status,'accepted_by_smtp');
    assert.equal(listDeliveries(db,other).total,0);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM channels WHERE id=?').get(telegramId).payload).config.preview_verified,true);
    db.prepare("UPDATE channel_test_deliveries SET status='failed',attempts=5 WHERE id=?").run(smtpTest);
    assert.equal(retryDelivery(db,smtpTest,other),false);
    assert.equal(retryDelivery(db,smtpTest,owner),true);
    engine.sendNotification=async()=>{throw new SmtpAcceptanceError('smtp_recipient_rejected');};
    await engine.deliverPending();
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM channel_test_deliveries WHERE id=?').get(smtpTest).payload).last_error,'smtp_recipient_rejected');
    assert.equal(db.prepare('SELECT attempts FROM channel_test_deliveries WHERE id=?').get(smtpTest).attempts,1);
    db.prepare('UPDATE channel_test_deliveries SET next_attempt=? WHERE id=?').run(Date.now()-1,smtpTest);
    engine.sendNotification=async()=>{throw Error('secret SMTP password must not be stored');};
    await engine.deliverPending();
    let retryRow=db.prepare('SELECT * FROM channel_test_deliveries WHERE id=?').get(smtpTest);
    assert.equal(retryRow.status,'pending');
    assert.equal(retryRow.attempts,2);
    assert.equal(JSON.parse(retryRow.payload).last_error,'delivery_failed');
    assert.doesNotMatch(JSON.stringify(retryRow),/secret SMTP password/);
    db.prepare('UPDATE channel_test_deliveries SET attempts=4,next_attempt=? WHERE id=?').run(Date.now()-1,smtpTest);
    await engine.deliverPending();
    retryRow=db.prepare('SELECT * FROM channel_test_deliveries WHERE id=?').get(smtpTest);
    assert.equal(retryRow.status,'failed');
    assert.equal(retryRow.attempts,5);
    assert.equal(retryDelivery(db,smtpTest,other),false);
    assert.equal(retryDelivery(db,smtpTest,owner),true);
    assert.equal(telegramTest.length,36);
  }finally{engine?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('a legacy schema-1 database upgrades additively and retains rows',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'fusion-channel-migration-'));let db;
  try{
    const filename=path.join(dir,'fusion.sqlite');db=openSimpleDatabase(filename);
    const owner=randomUUID();
    db.prepare('INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)').run(owner,'legacy@example.com','hash','{}');
    db.exec('DROP INDEX channel_test_deliveries_due; DROP TABLE channel_test_deliveries');
    db.prepare("UPDATE metadata SET value='1' WHERE key='schema_version'").run();db.close();
    db=openSimpleDatabase(filename);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'2');
    assert.equal(db.prepare('SELECT email FROM users WHERE id=?').get(owner).email,'legacy@example.com');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='channel_test_deliveries'").get());
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
  }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});

test('Delivery History combines existing monitor notifications with channel-only tests',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'fusion-delivery-history-'));let db;
  try{
    db=openSimpleDatabase(path.join(dir,'fusion.sqlite'));
    const owner=randomUUID(),monitor=randomUUID(),channel=randomUUID(),event=randomUUID(),outbox=randomUUID();
    db.prepare('INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)').run(owner,'history@example.com','hash','{}');
    saveMonitor(db,{id:monitor,name:'Real monitor',url:'https://example.com',enabled:true,paused:false,next_run:new Date().toISOString()},owner);
    db.prepare('INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)').run(channel,owner,JSON.stringify({id:channel,user_id:owner,name:'SMTP',provider:'smtp',enabled:true}));
    db.prepare('INSERT INTO events(id,monitor_id,status,payload,created_at) VALUES(?,?,?,?,?)').run(event,monitor,'changed','{}',Date.now());
    db.prepare('INSERT INTO outbox(id,event_id,channel_id,status,next_attempt,payload) VALUES(?,?,?,?,?,?)').run(outbox,event,channel,'sent',Date.now(),JSON.stringify({accepted_at:'2026-11-18T10:00:00.000Z',smtp_result:{status:'accepted_by_smtp',response_code:'250',message_id_sha256:'a'.repeat(64)}}));
    const testId=queueChannelTest(db,channel,owner);
    const history=listDeliveries(db,owner);
    assert.equal(history.total,2);
    assert.equal(history.items.find(item=>item.id===outbox).kind,'monitor');
    assert.equal(history.items.find(item=>item.id===outbox).smtp_result.status,'accepted_by_smtp');
    assert.equal(history.items.find(item=>item.id===testId).kind,'test');
    assert.equal(listDeliveries(db,owner,{status:'sent'}).total,1);
    assert.equal(listDeliveries(db,owner,{pageSize:1}).items.length,1);
  }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
