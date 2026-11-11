import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adblockEngine, loadVerifiedEngine, shouldBlockRequest } from '../server/dist/adblock.js';
import { installBrowserRouting } from '../server/dist/browser-experience.js';
import { EgressPolicy } from '../server/dist/egress.js';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { FiltersEngine } = require('@ghostery/adblocker');

test('verified EasyList/EasyPrivacy snapshot blocks ads and trackers but permits ordinary resources', async () => {
  const engine = await adblockEngine();
  const source = 'https://store.example.com/product';
  assert.equal(shouldBlockRequest(engine, 'https://www.google-analytics.com/analytics.js', source, 'script'), true);
  assert.equal(shouldBlockRequest(engine, 'https://ad.doubleclick.net/pagead/viewthroughconversion/123', source, 'script'), true);
  assert.equal(shouldBlockRequest(engine, 'https://cdn.example.com/app.js', source, 'script'), false);
});

test('Ghostery network exceptions and resource types are respected', () => {
  const engine = FiltersEngine.parse('||ads.example.net^$script,third-party\n@@||ads.example.net/allowed.js$script,third-party', { loadCosmeticFilters: false });
  const source = 'https://shop.example.com/';
  assert.equal(shouldBlockRequest(engine, 'https://ads.example.net/tracker.js', source, 'script'), true);
  assert.equal(shouldBlockRequest(engine, 'https://ads.example.net/allowed.js', source, 'script'), false);
  assert.equal(shouldBlockRequest(engine, 'https://ads.example.net/image.png', source, 'image'), false);
});

test('private workflow isolation takes priority and blocking OFF does not install an HTTP route', async () => {
  let handler, socketHandler, routes = 0;
  const context = { route: async (_pattern, callback) => { routes++; handler = callback; }, routeWebSocket: async (_pattern, callback) => { socketHandler = callback; } };
  await installBrowserRouting(context, 'https://shop.example.com/', { privateWorkflow: false, blockTrackers: false });
  assert.equal(routes, 0);
  assert.equal(typeof socketHandler, 'function');
  await installBrowserRouting(context, 'https://shop.example.com/', { privateWorkflow: true, blockTrackers: true });
  assert.equal(routes, 1);
  const decide = async (url, resourceType = 'script') => {
    const calls = [];
    await handler({ request: () => ({ url: () => url, resourceType: () => resourceType, isNavigationRequest: () => false, frame: () => ({ url: () => 'https://shop.example.com/' }) }), abort: async () => calls.push('abort'), continue: async () => calls.push('continue') });
    return calls;
  };
  assert.deepEqual(await decide('https://cdn.example.com/app.js'), ['abort'], 'security denies an ordinary cross-origin resource even if Ghostery allows it');
  assert.deepEqual(await decide('https://shop.example.com/app.js'), ['continue']);
  assert.deepEqual(await decide('https://www.google-analytics.com/analytics.js'), ['abort']);
  await assert.rejects(new EgressPolicy().target('http://127.0.0.1/'), /Private destinations/);
});

test('missing or corrupt snapshot fails observably without an unfiltered fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ghostery-bad-'));
  try {
    const data = join(root, 'snapshot.bin'), manifest = join(root, 'manifest.json');
    writeFileSync(data, Buffer.alloc(100_001));
    writeFileSync(manifest, JSON.stringify({ bytes: 100_001, snapshotSha256: '0'.repeat(64) }));
    await assert.rejects(loadVerifiedEngine(pathToFileURL(data), pathToFileURL(manifest)), error => error.code === 'adblock_unavailable');
    await assert.rejects(loadVerifiedEngine(pathToFileURL(join(root, 'missing.bin')), pathToFileURL(manifest)), error => error.code === 'adblock_unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
