import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { safeFetch } from '../server/dist/egress.js';
import { fetchMarkdownNew, parseMarkdownNewResponse } from '../server/dist/capture.js';
import { openSimpleDatabase, saveMonitor, getMonitor } from './db.mjs';

const original='https://example.com/article';
async function fixture(handler, run) {
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let body=''; for await(const part of req) body+=part;
    requests.push({method:req.method,headers:req.headers,body});
    handler(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const calls=[];
  const policy={target:async input=>{
    calls.push(input);
    if(input===original)return {url:new URL(original),address:'93.184.215.14',family:4};
    return {url:new URL(`http://127.0.0.1:${port}/`),address:'127.0.0.1',family:4};
  }};
  try {await run(policy,requests,calls);} finally {await new Promise(resolve=>server.close(resolve));}
}
test('auto/browser POST uses fixed endpoint, pinned socket, and markdown/JSON parsing',async()=>{
  for(const method of ['auto','browser']) await fixture((_req,res)=>{res.setHeader('Content-Type',method==='auto'?'text/markdown':'application/json');res.end(method==='auto'?'# Electronic Diversity Visa':'{"markdown":"# Electronic Diversity Visa"}');},async(policy,requests,calls)=>{
    assert.equal(await fetchMarkdownNew({url:original,markdown_render:method},policy,1000),'# Electronic Diversity Visa');
    assert.deepEqual(calls,[original,'https://markdown.new/']);
    assert.equal(requests[0].method,'POST');
    assert.deepEqual(JSON.parse(requests[0].body),{url:original,method});
    assert.match(requests[0].headers.accept,/text\/markdown/);
  });
});
test('POST rejects redirects and does not send the target URL to a second host',async()=>{
  await fixture((_req,res)=>{res.writeHead(307,{Location:'https://other.example/'});res.end();},async(policy,requests,calls)=>{
    await assert.rejects(fetchMarkdownNew({url:original},policy,1000),/redirect refused/);
    assert.equal(requests.length,1);assert.equal(calls.length,2);
  });
  await assert.rejects(safeFetch('https://other.example/',{target:async()=>{throw Error('must not connect');}},1000,100,{markdownNewBody:'{}'}),/Invalid markdown.new endpoint/);
});
test('provider HTTP errors, malformed and blocked content fail closed',async()=>{
  for(const [status,expected] of [[402,/paid access/],[429,/rate limited/],[500,/temporarily unavailable/]]) await fixture((_req,res)=>{res.writeHead(status);res.end('error');},async(policy)=>{
    await assert.rejects(fetchMarkdownNew({url:original},policy,1000),expected);
  });
  for(const [body,type] of [['{bad','application/json'],['[]','application/json'],['','text/markdown'],['Just a moment... Verify you are human','text/markdown']]) assert.throws(()=>parseMarkdownNewResponse(Buffer.from(body),type));
});
test('timeout and two megabyte response cap',async()=>{
  await fixture((_req,res)=>setTimeout(()=>res.end('late'),100),async(policy)=>{
    await assert.rejects(fetchMarkdownNew({url:original},policy,10),/timed out/);
  });
  await fixture((_req,res)=>res.end('x'.repeat(2_000_001)),async(policy)=>{
    await assert.rejects(fetchMarkdownNew({url:original},policy,1000),/too large/);
  });
});
test('SQLite keeps provider settings through create and update',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'markdown-monitor-'));
  try {const db=openSimpleDatabase(path.join(dir,'db.sqlite'));const user=randomUUID(),id=randomUUID();
    db.prepare('INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)').run(user,'test@example.com','hash','{}');
    saveMonitor(db,{id,name:'Provider',url:original,text_source:'markdown_new',markdown_render:'browser',next_run:new Date().toISOString()},user);
    const saved=getMonitor(db,id,user);assert.equal(saved.markdown_render,'browser');
    saveMonitor(db,{...saved,markdown_render:'auto'},user,{replace:true});assert.equal(getMonitor(db,id,user).markdown_render,'auto');db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
