import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const backend = read('server/package.json').version;
const frontend = read('frontend/package.json').version;
assert.match(backend, /^\d+\.\d+\.\d+$/, 'backend release version must be semantic');
assert.equal(frontend, backend, 'frontend version must match backend version');
for (const name of ['server', 'frontend']) {
  const lock = read(`${name}/package-lock.json`);
  assert.equal(lock.version, backend, `${name} lockfile version must match application version`);
  assert.equal(lock.packages?.['']?.version, backend, `${name} lockfile root version must match application version`);
}
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const badge = readme.match(/img\.shields\.io\/badge\/release-v([0-9]+\.[0-9]+\.[0-9]+)-blue/);
assert.equal(badge?.[1], backend, 'README release badge must match application version');
const status = readme.split(/^## Project status\s*$/im)[1]?.split(/^## /m)[0] ?? '';
const statusVersion = status.match(/Changd Fusion v([0-9]+\.[0-9]+\.[0-9]+)/);
assert.equal(statusVersion?.[1], backend, 'README Project Status version must match application version');
const vite = readFileSync(new URL('../frontend/vite.config.ts', import.meta.url), 'utf8');
assert.match(vite, /version:\s*packageJson\.version/, 'frontend build metadata version must derive from its package version');
console.log(`Release version ${backend} matches packages, lockfiles and README`);
