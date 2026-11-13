import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { compareVisual } from '../server/dist/comparison.js';
const { PNG }=createRequire(new URL('../server/dist/comparison.js',import.meta.url))('pngjs');

const image=(width,height,red=0,options={})=>{
  const png=new PNG({width,height});
  for(let i=0;i<png.data.length;i+=4){png.data[i]=red;png.data[i+3]=255;}
  return PNG.sync.write(png,options);
};

test('equal PNG bytes retain precise zero result after validating the image',()=>{
  const bytes=image(2,2);
  const result=compareVisual(bytes,bytes,'0',0.1);
  assert.equal(result.percent,'0.0000000000');
  assert.equal(result.changed,false);
  assert.equal(result.diff,null);
  assert.deepEqual(result.beforeDimensions,{width:2,height:2});
  assert.deepEqual(result.afterDimensions,{width:2,height:2});
  assert.throws(()=>compareVisual(bytes.subarray(0,33),bytes.subarray(0,33),'0',0.1));
});

test('different PNG bytes still use pixel comparison and preserve dimension semantics',()=>{
  const a=image(2,2,0,{filterType:0});
  const samePixels=image(2,2,0,{filterType:4});
  assert.equal(a.equals(samePixels),false);
  assert.equal(compareVisual(a,samePixels,'0',0.1).percent,'0.0000000000');
  const b=image(2,2,255);
  const changed=compareVisual(a,b,'10',0.1);
  assert.equal(changed.percent,'100.0000000000');
  assert.equal(changed.changed,true);
  assert.ok(changed.diff);
  const dimensions=compareVisual(a,image(3,2),'0',0.1);
  assert.equal(dimensions.percent,null);
  assert.equal(dimensions.dimensionChanged,true);
  assert.equal(dimensions.diff,null);
});
