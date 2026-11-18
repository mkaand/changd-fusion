import test from 'node:test';
import assert from 'node:assert/strict';
import { deliver, validateSmtpSubmission, SmtpAcceptanceError } from '../server/dist/notifications.js';

const recipient='receiver@example.com';
const config={host:'mail.example.com',port:465,from:'sender@example.com',to:recipient,username:'fixture',password:'top-secret'};
const event={id:'00000000-0000-4000-8000-000000000001',name:'Channel test',monitorId:'',textChanged:false,visualChanged:false,percent:null,textSummary:'',link:'https://example.com/',images:[],eventType:'test'};
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
