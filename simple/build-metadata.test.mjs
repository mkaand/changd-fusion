import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('build metadata verifier follows the release version and rejects a mismatched frontend bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'fusion-metadata-'));
  const commit = 'a'.repeat(40), branch = 'fix/visual-percent-v0.4.3';
  try {
    const dist = join(root, 'frontend', 'dist');
    mkdirSync(join(root, 'server'), { recursive: true });
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(root, 'server', 'package.json'), JSON.stringify({ version: '0.4.3' }));
    const verify = () => spawnSync(process.execPath, [new URL('./verify-build-metadata.mjs', import.meta.url).pathname, commit, branch, dist], { encoding: 'utf8' });
    writeFileSync(join(dist, 'assets', 'app.js'), `const metadata={version:"0.4.3",commit:"${commit}",branch:"${branch}"};`);
    assert.equal(verify().status, 0);
    writeFileSync(join(dist, 'assets', 'app.js'), `const metadata={version:"0.4.2",commit:"${commit}",branch:"${branch}"};`);
    assert.notEqual(verify().status, 0, 'a frontend built from another package version must fail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
