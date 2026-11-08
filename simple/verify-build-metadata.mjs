import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [commit, branch, dist = '/app/frontend/dist'] = process.argv.slice(2);
assert.match(commit ?? '', /^[0-9a-f]{40}$/i, 'expected a full commit SHA');
assert.ok(branch, 'expected a branch');

const assets = join(dist, 'assets');
const scripts = (await readdir(assets)).filter((name) => name.endsWith('.js'));
const source = (await Promise.all(scripts.map((name) => readFile(join(assets, name), 'utf8')))).join('\n');
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
assert.match(source, new RegExp(`commit:[\x60"']${escape(commit)}[\x60"'],branch:[\x60"']${escape(branch)}[\x60"']`), 'build metadata missing from frontend bundle');
console.log(`Frontend bundle contains commit ${commit} and branch ${branch}`);
