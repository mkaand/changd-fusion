import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('idle scheduler and non-browser capture imports defer PNG, Playwright and Ghostery',()=>{
  const script=`import { createRequire } from 'node:module';
    const require=createRequire(new URL('./server/dist/capture.js',import.meta.url));
    await import('./simple/engine.mjs');
    await import('./server/dist/capture.js');
    await import('./server/dist/region-picker.js');
    for(const name of ['pngjs','playwright','@ghostery/adblocker'])
      if(require.cache[require.resolve(name)]) throw Error(name+' loaded eagerly');`;
  assert.doesNotThrow(()=>execFileSync(process.execPath,['--input-type=module','-e',script],{
    cwd:new URL('../',import.meta.url).pathname,timeout:10_000,stdio:'pipe'
  }));
});
