import { FiltersEngine, Request } from '@ghostery/adblocker';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { CaptureFailure } from './errors.js';

const snapshot = new URL('../filters/ads-trackers.bin', import.meta.url);
const manifest = new URL('../filters/manifest.json', import.meta.url);
let sharedEngine: Promise<FiltersEngine> | undefined;

export async function loadVerifiedEngine(dataUrl: URL, metadataUrl: URL) {
  try {
    const size = (await stat(dataUrl)).size;
    if (size < 100_000 || size > 12_000_000) throw Error('Invalid filter size');
    const [bytes, metadata] = await Promise.all([readFile(dataUrl), readFile(metadataUrl, 'utf8')]);
    const expected = JSON.parse(metadata) as { snapshotSha256: string; bytes: number };
    if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.snapshotSha256)
      throw Error('Filter checksum mismatch');
    return FiltersEngine.deserialize(bytes);
  } catch {
    throw new CaptureFailure('browser_context', 'adblock_unavailable', 'Ad/tracker filters are unavailable or corrupt. Rebuild the image with verified filters before retrying this monitor.');
  }
}

export function adblockEngine() {
  return sharedEngine ??= loadVerifiedEngine(snapshot, manifest);
}

export function shouldBlockRequest(engine: FiltersEngine, url: string, sourceUrl: string, type: string) {
  const result = engine.match(Request.fromRawDetails({ url, sourceUrl, type: type as 'script' }));
  return result.match && !result.exception;
}
