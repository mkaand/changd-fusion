import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorInput } from '../server/dist/monitor-schema.js';
import { previewJinaText, clearTextPreviewSessions, jinaTextPreviewFetchOptions } from '../server/dist/text-picker.js';
import { applySelectedTextRule, generateSelectedTextRule, segmentSelectedText } from '../server/dist/selected-text.js';
import { captureFailure } from '../server/dist/errors.js';
import { capture, jinaReaderFetchOptions } from '../server/dist/capture.js';
import { compareCaptures } from './engine.mjs';
import { openSimpleDatabase, saveMonitor, getMonitor } from './db.mjs';

const url = 'https://example.com/product';
const ownerId = 'owner';
const cfg = { CAPTURE_TIMEOUT_MS: 1000 };
const lines = 'Product\nPrice: 12 USD\nSeller\nDelivery';

test('all Browser sources accept a selected rule; missing rules fail validation', () => {
  const rule = { version: 1, kind: 'bounded_context', before: 'Price: ', after: ' USD', max_length: 64 };
  for (const text_source of ['direct', 'jina', 'markdown_new']) {
    assert.equal(monitorInput.parse({ name: 'Price', url, text_source, extraction_mode: 'selected_text', extraction_rule: rule }).text_source, text_source);
    assert.equal(monitorInput.safeParse({ name: 'Price', url, text_source, extraction_mode: 'selected_text' }).success, false);
  }
  assert.equal(applySelectedTextRule(lines, rule), '12');
  assert.equal(applySelectedTextRule(lines.replace('12', '13'), rule), '13');
  assert.throws(() => applySelectedTextRule('Other content', rule), /could not be found/);
  try { applySelectedTextRule('Other content', rule); } catch (error) { assert.equal(captureFailure(error, 'text_extraction').code, 'selected_text_missing'); }
  try { applySelectedTextRule('Price: 1 USD Price: 2 USD', rule); } catch (error) { assert.equal(captureFailure(error, 'text_extraction').code, 'selected_text_ambiguous'); }
});

test('Direct Browser preview uses the supplied secure capture result and the same extraction rule', async () => {
  clearTextPreviewSessions();
  let captures = 0;
  const policy = { target: async () => ({}) };
  const preview = await previewJinaText({ ownerId, url, source: 'direct', directPreview: async () => { captures++; return lines; } }, cfg, policy);
  assert.equal(captures, 1);
  assert.equal(preview.total_line_count, 4);
  const selected = await previewJinaText({ ownerId, sessionId: preview.session_id, lineIndex: 1, selectedValue: '12' }, cfg, policy);
  assert.equal(selected.extracted, '12');
  assert.equal(applySelectedTextRule(lines.replace('12', '13'), selected.rule), '13');
  await assert.rejects(previewJinaText({ ownerId: 'other', sessionId: preview.session_id, lineIndex: 1, selectedValue: '12' }, cfg, policy), /expired/);
  clearTextPreviewSessions();
});

test('markdown.new preview uses the configured Auto/Browser response and never falls back', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push(JSON.parse(body));
    res.setHeader('content-type', 'text/markdown'); res.end(lines);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const policy = { target: async input => input === url
    ? { url: new URL(url), address: '93.184.215.14', family: 4 }
    : { url: new URL(`http://127.0.0.1:${port}/`), address: '127.0.0.1', family: 4 } };
  try {
    for (const markdownRender of ['auto', 'browser']) {
      clearTextPreviewSessions();
      const preview = await previewJinaText({ ownerId, url, source: 'markdown_new', markdownRender }, cfg, policy);
      assert.equal(preview.total_line_count, 4);
    }
    assert.deepEqual(requests, [{ url, method: 'auto' }, { url, method: 'browser' }]);
  } finally { clearTextPreviewSessions(); await new Promise(resolve => server.close(resolve)); }
});

test('markdown.new selected capture compares only the value and failures preserve the previous result', async () => {
  let text = lines;
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/markdown'); res.end(text); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const policy = { target: async input => input === url
    ? { url: new URL(url), address: '93.184.215.14', family: 4 }
    : { url: new URL(`http://127.0.0.1:${port}/`), address: '127.0.0.1', family: 4 } };
  const rule = { version: 1, kind: 'bounded_context', before: 'Price: ', after: ' USD', max_length: 64 };
  const monitor = monitorInput.parse({ name: 'Price', url, text_source: 'markdown_new', extraction_mode: 'selected_text', extraction_rule: rule });
  try {
    const first = await capture(monitor, cfg, policy);
    assert.equal(first.text, '12');
    text = lines.replace('12', '13');
    const second = await capture(monitor, cfg, policy);
    assert.equal(second.text, '13');
    assert.equal((await compareCaptures({ text_content: first.text }, second, monitor, '/tmp')).textChanged, true);
    text = 'Unrelated content';
    await assert.rejects(capture(monitor, cfg, policy));
    assert.equal(first.text, '12');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('SQLite preserves selected source, render mode and rule across create/read/update', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'selected-sources-'));
  try {
    const db = openSimpleDatabase(path.join(root, 'fusion.sqlite'));
    const user = randomUUID(), id = randomUUID();
    db.prepare('INSERT INTO users(id,email,password_hash,payload) VALUES(?,?,?,?)').run(user, 'selected@example.com', 'hash', '{}');
    const rule = { version: 1, kind: 'bounded_context', before: 'Price: ', after: ' USD', max_length: 64 };
    saveMonitor(db, { id, name: 'Selected', url, text_source: 'markdown_new', markdown_render: 'browser', extraction_mode: 'selected_text', extraction_rule: rule }, user);
    const saved = getMonitor(db, id, user);
    assert.equal(saved.markdown_render, 'browser'); assert.deepEqual(saved.extraction_rule, rule);
    const v3 = generateSelectedTextRule(segmentSelectedText('Product\nPrice: 12 USD\nSeller').map(item => item.text), 1, '12').rule;
    saveMonitor(db, { ...saved, extraction_rule: v3 }, user, { replace: true });
    assert.deepEqual(getMonitor(db, id, user).extraction_rule, v3);
    saveMonitor(db, { ...saved, text_source: 'direct', extraction_mode: 'full_text', extraction_rule: null }, user, { replace: true });
    const updated = getMonitor(db, id, user);
    assert.equal(updated.text_source, 'direct'); assert.equal(updated.extraction_rule, null);
    db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Jina selected preview and capture keep Reader content and no-cache behavior', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers);
    res.setHeader('content-type', 'text/plain'); res.end(lines);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const policy = { target: async input => input === url
    ? { url: new URL(url), address: '93.184.215.14', family: 4 }
    : { url: new URL(`http://127.0.0.1:${port}/`), address: '127.0.0.1', family: 4 } };
  const rule = { version: 1, kind: 'bounded_context', before: 'Price: ', after: ' USD', max_length: 64 };
  const monitor = monitorInput.parse({ name: 'Jina price', url, text_source: 'jina', extraction_mode: 'selected_text', extraction_rule: rule });
  try {
    clearTextPreviewSessions();
    const preview = await previewJinaText({ ownerId, url, source: 'jina' }, cfg, policy);
    assert.equal(preview.total_line_count, 4);
    assert.equal((await capture(monitor, cfg, policy)).text, '12');
    const generated = await previewJinaText({ ownerId, sessionId: preview.session_id, lineIndex: 1, selectedValue: '12' }, cfg, policy);
    assert.equal(generated.rule.version, 3);
    assert.equal((await capture({ ...monitor, extraction_rule: generated.rule }, cfg, policy)).text, '12');
    assert.equal(requests.length, 3);
    assert.equal(jinaTextPreviewFetchOptions.jinaNoCache, true);
    assert.equal(jinaReaderFetchOptions(monitor).jinaNoCache, true);
  } finally { clearTextPreviewSessions(); await new Promise(resolve => server.close(resolve)); }
});

test('Jina and markdown.new capture a changed selected price using the original rule', async () => {
  let content='Product A\n34.199,05 TL\nSeller A\nProduct B\n34.199,05 TL\nSeller B';
  const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/markdown');res.end(content);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const policy={target:async input=>input===url
    ? {url:new URL(url),address:'93.184.215.14',family:4}
    : {url:new URL(`http://127.0.0.1:${port}/`),address:'127.0.0.1',family:4}};
  try {
    for(const text_source of ['jina','markdown_new']) {
      clearTextPreviewSessions();
      content='Product A\n34.199,05 TL\nSeller A\nProduct B\n34.199,05 TL\nSeller B';
      const preview=await previewJinaText({ownerId,url,source:text_source,markdownRender:'browser'},cfg,policy);
      const selected=await previewJinaText({ownerId,sessionId:preview.session_id,lineIndex:1,selectedValue:'34.199,05 TL'},cfg,policy);
      const monitor=monitorInput.parse({name:'Price',url,text_source,markdown_render:'browser',extraction_mode:'selected_text',extraction_rule:selected.rule});
      assert.equal((await capture(monitor,cfg,policy)).text,'34.199,05 TL');
      content='Product A\nPromotion today\n35.999,00 TL\nSeller A\nProduct B\n34.199,05 TL\nSeller B';
      assert.equal((await capture(monitor,cfg,policy)).text,'35.999,00 TL');
    }
  } finally {clearTextPreviewSessions();await new Promise(resolve=>server.close(resolve));}
});

test('Jina and markdown.new reject a surviving adjacent duplicate after the selected field is removed', async () => {
  const old='34.199,05 TL', changed='35.999,00 TL';
  let content=`Product A\n${old}\n${old}`;
  const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/markdown');res.end(content);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const policy={target:async input=>input===url
    ? {url:new URL(url),address:'93.184.215.14',family:4}
    : {url:new URL(`http://127.0.0.1:${port}/`),address:'127.0.0.1',family:4}};
  try {
    for(const text_source of ['jina','markdown_new']) for(const lineIndex of [1,2]) {
      clearTextPreviewSessions();content=`Product A\n${old}\n${old}`;
      const preview=await previewJinaText({ownerId,url,source:text_source,markdownRender:'browser'},cfg,policy);
      const selected=await previewJinaText({ownerId,sessionId:preview.session_id,lineIndex,selectedValue:old},cfg,policy);
      const monitor=monitorInput.parse({name:'Duplicate price',url,text_source,markdown_render:'browser',extraction_mode:'selected_text',extraction_rule:selected.rule});
      content=`Product A\n${old}`;
      await assert.rejects(capture(monitor,cfg,policy),/ambiguous|could not be found/);
      content=`Product A\n${lineIndex===1?changed:old}\n${lineIndex===2?changed:old}`;
      assert.equal((await capture(monitor,cfg,policy)).text,changed);
    }
  } finally {clearTextPreviewSessions();await new Promise(resolve=>server.close(resolve));}
});

test('markdown.new Auto and Browser segmented previews produce capture-equivalent V3 rules', async () => {
  let current = `# Ürün\n${'A long description. '.repeat(80)}\nPrice: 34.819,01 ₺\nSeller`;
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/markdown'); res.end(current); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const policy = { target: async input => input === url
    ? { url: new URL(url), address: '93.184.215.14', family: 4 }
    : { url: new URL(`http://127.0.0.1:${port}/`), address: '127.0.0.1', family: 4 } };
  try {
    for (const markdownRender of ['auto', 'browser']) {
      clearTextPreviewSessions(); current = current.replace('35.000,00', '34.819,01');
      const preview = await previewJinaText({ ownerId, url, source: 'markdown_new', markdownRender }, cfg, policy);
      assert.ok(preview.total_line_count > 5);
      const selected = preview.items.find(item => item.text === 'Price: 34.819,01 ₺');
      assert.ok(selected);
      const generated = await previewJinaText({ ownerId, sessionId: preview.session_id, lineIndex: selected.index, selectedValue: '34.819,01 ₺' }, cfg, policy);
      const monitor = monitorInput.parse({ name: 'Markdown price', url, text_source: 'markdown_new', markdown_render: markdownRender, extraction_mode: 'selected_text', extraction_rule: generated.rule });
      assert.equal((await capture(monitor, cfg, policy)).text, '34.819,01 ₺');
      current = current.replace('34.819,01', '35.000,00');
      assert.equal((await capture(monitor, cfg, policy)).text, '35.000,00 ₺');
      current = '# Missing price';
      await assert.rejects(capture(monitor, cfg, policy));
      current = `# Ürün\n${'A long description. '.repeat(80)}\nPrice: 34.819,01 ₺\nSeller`;
    }
  } finally { clearTextPreviewSessions(); await new Promise(resolve => server.close(resolve)); }
});
