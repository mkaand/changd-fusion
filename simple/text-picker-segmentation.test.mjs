import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentSelectedText, generateSelectedTextRule, generateLegacySelectedTextRule, applySelectedTextRule } from '../server/dist/selected-text.js';
import { previewJinaText, clearTextPreviewSessions, TEXT_PREVIEW_IDLE_MS, TEXT_PREVIEW_MAX_MS } from '../server/dist/text-picker.js';
import { compareCaptures } from './engine.mjs';
import { captureFailure } from '../server/dist/errors.js';

const price = '34.819,01 ₺';
const content = `${price}\n${price}\nKredi kartınızdan ${price} çekilecek.`;

test('segmentation splits long browser and Markdown blocks while preserving exact selected spans', () => {
  const raw = `# Ürün\n<p>${'A long paragraph. '.repeat(90)}${price} sonraki ödeme.</p><li>İkinci ürün</li>\nURL https://example.com/a.b?price=34.819,01`;
  const segments = segmentSelectedText(raw);
  assert.ok(segments.length > 5);
  assert.ok(segments.every(item => item.text.length <= 800));
  assert.ok(segments.some(item => item.text.includes(price)));
  assert.ok(segments.some(item => item.text.includes('https://example.com/a.b?price=34.819,01')));
  for (const item of segments) assert.equal(raw.slice(item.start, item.end), item.text);
  assert.ok(segments.every((item, index) => !index || item.start >= segments[index - 1].end));
  const minified = 'let value=34.819,01;console.log(value);'.repeat(4000);
  const chunks = segmentSelectedText(minified);
  assert.ok(chunks.length > 1 && chunks.length <= 4096);
  assert.throws(() => segmentSelectedText('x'.repeat(200_001)), /too large/);
});

test('clicked repeated Turkish price uses stable position and never chooses the first duplicate', () => {
  const lines = segmentSelectedText(content).map(item => item.text);
  assert.equal(lines.length, 3);
  const first = generateSelectedTextRule(lines, 0, price);
  const second = generateSelectedTextRule(lines, 1, price);
  const sentence = generateSelectedTextRule(lines, 2, price);
  assert.equal(first.rule.version, 3); assert.equal(second.rule.version, 3);
  assert.notDeepEqual(first.rule.anchors, second.rule.anchors);
  assert.equal(applySelectedTextRule(content.replace(price, '35.000,00 ₺'), first.rule), '35.000,00 ₺');
  assert.equal(applySelectedTextRule(content.replace(price, '35.000,00 ₺'), second.rule), price);
  assert.throws(() => applySelectedTextRule(`${price}\n${content}`, second.rule), /context changed/);
  assert.equal(applySelectedTextRule(content.replaceAll(price, '36.123,45 ₺'), sentence.rule), '36.123,45 ₺');
  assert.ok(JSON.stringify(second.rule).includes('Kredi kartınızdan'));
  assert.ok(!JSON.stringify(second.rule).includes(price));
});

test('genuinely ambiguous repeated values and missing context fail without a fallback', () => {
  const lines = [price, price];
  assert.throws(() => generateSelectedTextRule(lines, 1, price), /cannot be distinguished safely/);
  const unique = generateSelectedTextRule(segmentSelectedText(content).map(item => item.text), 1, price);
  assert.throws(() => applySelectedTextRule(`${price}\n${price}`, unique.rule), /context is missing/);
  try { applySelectedTextRule(`${price}\n${price}`, unique.rule); } catch (error) { assert.equal(captureFailure(error, 'text_extraction').code, 'selected_text_missing'); }
  assert.throws(() => generateSelectedTextRule([`${price} + ${price}`], 0, price), /more than once/);
});

test('saved V1/V2 extraction semantics remain unchanged', () => {
  const v1 = { version: 1, kind: 'bounded_context', before: 'Price: ', after: ' USD', max_length: 64 };
  assert.equal(applySelectedTextRule('Price: 12 USD', v1), '12');
  const oldLines = ['Product', 'Price: 12 USD', 'Seller', 'Delivery'];
  const v2 = generateLegacySelectedTextRule(oldLines, 1, '12').rule;
  assert.equal(v2.version, 2);
  assert.equal(applySelectedTextRule(oldLines.join('\n').replace('12', '13'), v2), '13');
});

test('preview search extends idle expiry but never passes absolute lifetime; expired sessions cannot revive', async () => {
  const now = Date.now, started = 1_800_000_000_000;
  Date.now = () => started;
  clearTextPreviewSessions();
  let calls = 0;
  const policy = { target: async () => ({}) };
  try {
    const preview = await previewJinaText({ ownerId: 'a', url: 'https://example.com', source: 'direct', query: 'Price', directPreview: async () => { calls++; return 'Product\nPrice: 12 USD\nSeller'; } }, { CAPTURE_TIMEOUT_MS: 1000 }, policy);
    assert.equal(preview.matching_line_count, 1);
    assert.equal(Date.parse(preview.expires_at), started + TEXT_PREVIEW_IDLE_MS);
    Date.now = () => started + 150_000;
    const search = await previewJinaText({ ownerId: 'a', sessionId: preview.session_id, query: '', offset: 1, limit: 1 }, { CAPTURE_TIMEOUT_MS: 1000 }, policy);
    assert.equal(search.items[0].index, 1);
    assert.equal(Date.parse(search.expires_at), started + 150_000 + TEXT_PREVIEW_IDLE_MS);
    Date.now = () => started + TEXT_PREVIEW_MAX_MS - 10_000;
    // A session must be kept active along the way to reach the absolute cap.
    for (const advance of [280_000, 410_000, 540_000]) {
      Date.now = () => started + advance;
      await previewJinaText({ ownerId: 'a', sessionId: preview.session_id, query: 'Price' }, { CAPTURE_TIMEOUT_MS: 1000 }, policy);
    }
    Date.now = () => started + TEXT_PREVIEW_MAX_MS - 10_000;
    const capped = await previewJinaText({ ownerId: 'a', sessionId: preview.session_id, query: 'Price' }, { CAPTURE_TIMEOUT_MS: 1000 }, policy);
    assert.equal(Date.parse(capped.expires_at), started + TEXT_PREVIEW_MAX_MS);
    Date.now = () => started + TEXT_PREVIEW_MAX_MS + 1;
    await assert.rejects(previewJinaText({ ownerId: 'a', sessionId: preview.session_id, query: 'Price' }, { CAPTURE_TIMEOUT_MS: 1000 }, policy), error => error.status === 410);
    assert.equal(calls, 1, 'search and selection do not refetch the provider');
  } finally { Date.now = now; clearTextPreviewSessions(); }
});

test('owner isolation and eight-session capacity remain bounded', async () => {
  clearTextPreviewSessions();
  const policy = { target: async () => ({}) };
  const cfg = { CAPTURE_TIMEOUT_MS: 1000 };
  let captures = 0;
  try {
    const sessions = [];
    for (let index = 0; index < 8; index++) sessions.push(await previewJinaText({ ownerId: `owner-${index}`, url: 'https://example.com', source: 'direct', directPreview: async () => { captures++; return 'Product\nPrice'; } }, cfg, policy));
    await assert.rejects(previewJinaText({ ownerId: 'extra', url: 'https://example.com', source: 'direct', directPreview: async () => { captures++; return 'Text'; } }, cfg, policy), error => error.status === 429);
    await assert.rejects(previewJinaText({ ownerId: 'other', sessionId: sessions[0].session_id, query: '' }, cfg, policy), error => error.status === 410);
    assert.equal(captures, 8);
  } finally { clearTextPreviewSessions(); }
});

test('V3 comparison reports the selected change only, preserving baseline on extraction failure', () => {
  const lines = segmentSelectedText(content).map(item => item.text);
  const rule = generateSelectedTextRule(lines, 1, price).rule;
  const monitor = { kind: 'browser', text_enabled: true, visual_enabled: false, extraction_mode: 'selected_text', extraction_rule: rule, normalize_whitespace: true, ignore_text: [], ignore_case: false };
  const before = { text_content: applySelectedTextRule(content, rule) };
  const unchanged = { text: applySelectedTextRule(content.replace(price, '35.000,00 ₺'), rule) };
  assert.equal(compareCaptures(before, unchanged, monitor, '/tmp').textChanged, false);
  assert.throws(() => applySelectedTextRule('No price or context', rule));
  assert.equal(before.text_content, price);
});
