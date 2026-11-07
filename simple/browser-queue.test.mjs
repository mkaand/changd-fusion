import assert from "node:assert/strict";
import test from "node:test";
import { BrowserQueue } from "./browser-queue.mjs";
test("preview priority acquires and releases a single local slot",async()=>{
  const queue=new BrowserQueue();
  const a=await queue.acquirePreview();
  assert.equal(a?.workload,"preview");
  assert.equal(queue.status.preview,true);
  assert.equal(await queue.acquirePreview({waitMs:20}),null);
  await a.release();
  const b=await queue.acquirePreview();
  assert.equal(b?.slot,1);
  await b.release();
  assert.equal(queue.status.preview,false);
  queue.close();
  assert.equal(await queue.acquirePreview(),null);
});
