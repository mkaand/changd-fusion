import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deliver, validateSmtpSubmission, SmtpAcceptanceError, smtpMessageId } from '../server/dist/notifications.js';
const nodemailer=createRequire(new URL('../server/package.json',import.meta.url))('nodemailer');

const recipient='receiver@example.com';
const config={host:'mail.example.com',port:465,from:'sender@example.com',to:recipient,username:'fixture',password:'top-secret'};
const event={id:'00000000-0000-4000-8000-000000000001',name:'Channel test',monitorId:'',textChanged:false,visualChanged:false,percent:null,textSummary:'',link:'https://fusion.example.com/settings',images:[],eventType:'test',checkedAt:'2026-11-18T10:30:00.000Z'};
const storage={read:async()=>{throw Error('No test image should be read');}};
const policy={target:async()=>({address:'93.184.215.14'})};
const send=(info)=>deliver('smtp',config,event,storage,{policy,smtp:()=>({sendMail:async()=>info,close(){}})});
const valid={accepted:[recipient],rejected:[],response:'250 2.0.0 queued as sensitive-queue-id',messageId:'<fixture@example.com>'};

test('SMTP receipt records only acceptance, response code and message ID hash',async()=>{
  const result=await send(valid);
  assert.equal(result.smtp.status,'accepted_by_smtp');
  assert.equal(result.smtp.response_code,'250');
  assert.match(result.smtp.message_id_sha256,/^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result),/receiver|sender|top-secret|sensitive-queue-id|fixture@example/);
});

for(const [label,info,code] of [
  ['rejected intended recipient',{...valid,rejected:[recipient]},'smtp_recipient_rejected'],
  ['empty acceptance',{...valid,accepted:[]},'smtp_no_recipient_accepted'],
  ['wrong accepted recipient',{...valid,accepted:['other@example.com']},'smtp_no_recipient_accepted'],
  ['non-success SMTP response',{...valid,response:'450 temporarily unavailable'},'smtp_invalid_response'],
  ['missing message ID',{...valid,messageId:''},'smtp_missing_message_id'],
])test(`SMTP ${label} fails for retry`,async()=>{
  await assert.rejects(send(info),error=>error instanceof SmtpAcceptanceError&&error.code===code);
});

test('SMTP result validation does not expose raw recipient or response',()=>{
  const safe=validateSmtpSubmission(valid,recipient);
  assert.deepEqual(Object.keys(safe).sort(),['message_id_sha256','response_code','status']);
  assert.doesNotMatch(JSON.stringify(safe),/receiver|sensitive-queue-id/);
});

test('Message-ID is unique and uses the configured sender domain',()=>{
  const first=smtpMessageId('alerts@example.com'),second=smtpMessageId('alerts@example.com');
  assert.match(first,/^<[0-9a-f-]{36}@example\.com>$/);
  assert.notEqual(first,second);
  assert.match(smtpMessageId('alerts@bücher.de'),/@xn--bcher-kva\.de>$/);
  assert.throws(()=>smtpMessageId('alerts@bad domain'),/Invalid SMTP sender domain/);
});

test('SMTP test mail has aligned sender/envelope, timestamp, HTTPS link and valid MIME alternatives',async()=>{
  let sent,transportOptions;
  const smtp=(options)=>{transportOptions=options;return {sendMail:async data=>{
    sent=data;
    return {accepted:[config.to],rejected:[],response:'250 2.0.0 queued',messageId:data.messageId};
  },close(){}};};
  const result=await deliver('smtp',config,event,storage,{policy,smtp});
  assert.equal(result.smtp.status,'accepted_by_smtp');
  assert.equal(transportOptions.auth.user,config.username);
  assert.equal(sent.from,config.from);
  assert.deepEqual(sent.envelope,{from:config.from,to:config.to});
  assert.match(sent.messageId,/^<[0-9a-f-]{36}@example\.com>$/);
  assert.ok(sent.date instanceof Date);
  for(const body of [sent.text,sent.html]){
    assert.match(body,/Changd Fusion notification channel test/);
    assert.match(body,/2026-11-18T10:30:00\.000Z/);
    assert.match(body,/https:\/\/fusion\.example\.com\/settings/);
    assert.match(body,/No monitor was checked or changed/);
  }
  assert.doesNotMatch(sent.text+sent.html,/changd-fusion\.example\.com|password|top-secret/);
  const raw=(await nodemailer.createTransport({streamTransport:true,buffer:true}).sendMail(sent)).message.toString();
  assert.match(raw,/^From: sender@example\.com/m);
  assert.match(raw,/^Date: /m);
  assert.match(raw,/^Message-ID: <[0-9a-f-]{36}@example\.com>/mi);
  assert.match(raw,/Content-Type: multipart\/alternative/i);
  assert.match(raw,/Content-Type: text\/plain/i);
  assert.match(raw,/Content-Type: text\/html/i);
});

test('channel test does not invent an HTTPS link from an HTTP configuration',async()=>{
  let sent;
  await deliver('smtp',config,{...event,link:'http://localhost:8127/'},storage,{policy,smtp:()=>({sendMail:async data=>{
    sent=data;return {...valid,messageId:data.messageId};
  },close(){}})});
  assert.doesNotMatch(sent.text+sent.html,/http:\/\/localhost|https:\/\/localhost/);
});
