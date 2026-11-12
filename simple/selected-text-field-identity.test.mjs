import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentSelectedText, generateSelectedTextRule, applySelectedTextRule } from '../server/dist/selected-text.js';
import { compareCaptures, FusionEngine } from './engine.mjs';
import { captureFailure } from '../server/dist/errors.js';
import { openSimpleDatabase, saveMonitor, getMonitor } from './db.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const oldPrice = '34.199,05 TL';
const newPrice = '35.999,00 TL';
const ruleFor = (text, index, value = oldPrice) => generateSelectedTextRule(segmentSelectedText(text).map(segment => segment.text), index, value).rule;

test('dynamic comparison text beside a selected price is not its identity', () => {
  const before = `Product A\nPrice: ${oldPrice} (was 40.000 TL)\nSeller A`;
  const rule = ruleFor(before, 1);
  const after = `Product A\nPrice: ${newPrice} (was 42.000 TL)\nSeller A`;
  assert.equal(applySelectedTextRule(after, rule), newPrice);
});

test('a selected product price survives unrelated line insertion and cohort growth', () => {
  const before = `Product A\n${oldPrice}\nFree shipping\nProduct B\n${oldPrice}\nIn stock`;
  const rule = ruleFor(before, 1);
  const inserted = `Product A\nPromotion today\n${newPrice}\nFree shipping\nProduct B\n${oldPrice}\nIn stock`;
  assert.equal(applySelectedTextRule(inserted, rule), newPrice);
  const addedPrice = `Product A\n${newPrice}\nFree shipping\nProduct B\n${oldPrice}\nIn stock\nProduct C\n18.000,00 TL`;
  assert.equal(applySelectedTextRule(addedPrice, rule), newPrice);
});

test('changing shipping text does not invalidate a still identifiable standalone price', () => {
  const before = `${oldPrice}\nFree shipping\nSeller A`;
  const rule = ruleFor(before, 0);
  assert.equal(applySelectedTextRule(`${newPrice}\nShipping 5 TL\nSeller A`, rule), newPrice);
});

test('selected product remains distinct when another product changes; missing field fails safely', () => {
  const before = `Product A\n${oldPrice}\nFree shipping\nProduct B\n${oldPrice}\nIn stock`;
  const rule = ruleFor(before, 1);
  assert.equal(applySelectedTextRule(before.replace(`Product B\n${oldPrice}`, `Product B\n${newPrice}`), rule), oldPrice);
  assert.throws(() => applySelectedTextRule(`Product A\nFree shipping\nProduct B\n${oldPrice}\nIn stock`, rule), /could not be found/);
  assert.equal(applySelectedTextRule(`Product A\n${newPrice}\nFree shipping\nProduct B\n${oldPrice}\nIn stock`, rule), newPrice);
  assert.equal(compareCaptures({text_content:oldPrice},{text:newPrice},{text_enabled:true},'/tmp').textChanged,true);
});

test('saved V3 rules omit dynamic value and resolve when the target remains unique', () => {
  const rule = {version:3,kind:'contextual_segments',anchors:[{shape:'Product A',offset:-1}],prefix:'',suffix:'',max_length:64,cohort:{shape:'# TL',count:2}};
  assert.equal(applySelectedTextRule(`Product A\n${newPrice}\nProduct B\nDescription\n${oldPrice}\nProduct C\n19.000,00 TL`,rule),newPrice);
  assert.throws(() => applySelectedTextRule(`${newPrice}\n${oldPrice}`,rule), /ambiguous|context is missing/);
});

test('existing V3 suffix with a changing comparison price can still identify the selected field', () => {
  const rule={version:3,kind:'contextual_segments',anchors:[],prefix:'Price: ',suffix:' (was 40.000 TL)',max_length:64};
  assert.equal(applySelectedTextRule('Product A\nPrice: 35.999,00 TL (was 42.000 TL)\nSeller A',rule),newPrice);
});

test('a standalone price keeps its field when numeric presentation changes', () => {
  const rule=ruleFor(`Product A\n${oldPrice}\nSeller A`,1);
  assert.equal(applySelectedTextRule('Product A\n35 999,00 ₺\nSeller A',rule),'35 999,00 ₺');
});

test('scheduled baseline survives extraction failure and recovered value creates a change and outbox item', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'selected-identity-'));
  let db, engine;
  try {
    db=openSimpleDatabase(path.join(dir,'fusion.sqlite'));
    const user=randomUUID(),id=randomUUID(),channel=randomUUID();
    db.prepare('INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)').run(user,'identity@example.com','hash','{}');
    const first=`Product A\n${oldPrice}\nSeller A`;
    const rule=ruleFor(first,1);
    saveMonitor(db,{id,user_id:user,name:'Price',url:'https://example.com/product',kind:'browser',text_source:'jina',extraction_mode:'selected_text',extraction_rule:rule,text_enabled:true,visual_enabled:false,enabled:true,paused:false,notification_enabled:true,interval_seconds:30,next_run:new Date(Date.now()-1000).toISOString()},user);
    db.prepare('INSERT INTO channels(id,user_id,payload) VALUES(?,?,?)').run(channel,user,JSON.stringify({id,user_id:user,name:'Telegram',provider:'telegram',enabled:true}));
    db.prepare('INSERT INTO monitor_channels(monitor_id,channel_id) VALUES(?,?)').run(id,channel);
    const pages=[first,'Product A\nSeller A',`Product A\n${newPrice}\nSeller A`,`Product A\n${newPrice}\nSeller A`];
    const browser={status:{preview:false},capture:async m=>{
      try{return {ok:true,text:applySelectedTextRule(pages.shift(),m.extraction_rule),screenshot:null,http_status:200};}
      catch(error){return {ok:false,code:captureFailure(error,'text_extraction').code};}
    },close(){}};
    engine=new FusionEngine(db,{dataDir:dir,channelKey:'a'.repeat(64),browser,sendNotification:async()=>{}});
    const tick=async()=>{db.prepare('UPDATE monitors SET next_run=? WHERE id=?').run(Date.now()-1,id);await engine.tick();};
    await tick(); const baseline=getMonitor(db,id,user).baseline_id;
    await tick(); assert.equal(getMonitor(db,id,user).baseline_id,baseline);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE status='failed'").get().n,1);
    await tick(); const changedBaseline=getMonitor(db,id,user).baseline_id;
    assert.notEqual(changedBaseline,baseline);
    const changed=JSON.parse(db.prepare("SELECT payload FROM events WHERE status='changed'").get().payload);
    assert.match(JSON.stringify(changed.text_diff),/34\.199,05/);
    assert.match(JSON.stringify(changed.text_diff),/35\.999,00/);
    assert.equal(db.prepare('SELECT count(*) n FROM outbox').get().n,1);
    await tick(); assert.notEqual(getMonitor(db,id,user).baseline_id,changedBaseline);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE status='unchanged'").get().n,1);
  } finally {engine?.close();db?.close();rmSync(dir,{recursive:true,force:true});}
});
