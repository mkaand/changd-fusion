// Controlled maintenance command. The application never downloads lists at runtime.
import { FiltersEngine } from '@ghostery/adblocker';
import { createHash } from 'node:crypto';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const commit = '6f0610bf5eec1f31c4975ce0e707cdf47023e5b5';
const base = `https://raw.githubusercontent.com/ghostery/adblocker/${commit}/packages/adblocker/assets/easylist/`;
const sources = [
  { name: 'EasyList', file: 'easylist.txt', sha256: '318f849794a94697a04d470f6162523befd43ce58d2477d4e321f727cbbb0ccd' },
  { name: 'EasyPrivacy', file: 'easyprivacy.txt', sha256: 'd0b04edb90a4e9ef6f3a371d08a9afd90057a22abe843586409fe08edfa89262' },
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const filters = [];
for (const source of sources) {
  const response = await fetch(base + source.file, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw Error(`${source.name} fetch failed: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (length > 4_000_000) throw Error(`${source.name} exceeds the allowed size`);
  const chunks = [];
  let size = 0;
  if (!response.body) throw Error(`${source.name} response is empty`);
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 4_000_000) throw Error(`${source.name} exceeds the allowed size`);
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== source.sha256) throw Error(`${source.name} checksum mismatch`);
  filters.push(bytes.toString('utf8'));
}
const snapshot = FiltersEngine.parse(filters.join('\n'), { loadCosmeticFilters: false }).serialize();
if (snapshot.length < 100_000 || snapshot.length > 12_000_000) throw Error('Unexpected filter snapshot size');
const output = join(dirname(fileURLToPath(import.meta.url)), '..', 'filters');
await mkdir(output, { recursive: true });
await writeFile(join(output, 'ads-trackers.bin.tmp'), snapshot);
await rename(join(output, 'ads-trackers.bin.tmp'), join(output, 'ads-trackers.bin'));
await writeFile(join(output, 'manifest.json'), JSON.stringify({
  engine: '@ghostery/adblocker@2.20.3', upstreamCommit: commit,
  sources: sources.map(({ name, file, sha256 }) => ({ name, url: base + file, sha256 })),
  license: 'https://easylist.to/pages/licence.html',
  snapshotSha256: digest(snapshot), bytes: snapshot.length,
}, null, 2) + '\n');
console.log(`Verified ${sources.map(s => s.name).join(' + ')}; snapshot ${snapshot.length} bytes, sha256 ${digest(snapshot)}`);
