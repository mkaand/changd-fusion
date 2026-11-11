import test from "node:test";
import assert from "node:assert/strict";
import { nextPreviewExpiry, REGION_PREVIEW_MAX_LIFETIME_MS, REGION_PREVIEW_SCROLL_EXTENSION_MS, REGION_PREVIEW_ABSOLUTE_LIFETIME_MS, regionPreviewFailure } from "../server/dist/region-picker.js";
import { HttpError, CaptureFailure } from "../server/dist/errors.js";

test("45-second initial expiry extends only for effective scroll and caps at 180 seconds",()=>{
  const created=1000,initial=created+REGION_PREVIEW_MAX_LIFETIME_MS;
  assert.equal(REGION_PREVIEW_SCROLL_EXTENSION_MS,20000);
  assert.equal(REGION_PREVIEW_ABSOLUTE_LIFETIME_MS,180000);
  assert.equal(nextPreviewExpiry(created,initial,created+10000,false),initial);
  assert.equal(nextPreviewExpiry(created,initial,initial,false),initial);
  const second=nextPreviewExpiry(created,initial,created+10000,true);
  assert.equal(second,initial+20000);
  assert.equal(nextPreviewExpiry(created,second,created+30000,true),second+20000);
  let deadline=initial;
  for(let i=0;i<20;i++) deadline=nextPreviewExpiry(created,deadline,created+10000,true);
  assert.equal(deadline,created+180000);
  assert.equal(nextPreviewExpiry(created,initial,initial,true),initial,"expired sessions cannot revive");
  assert.equal(nextPreviewExpiry(created,deadline,created+181000,true),deadline);
});

test("actual expiry is HTTP 410 while an operation timeout remains HTTP 504",()=>{
  const expired=regionPreviewFailure(new HttpError(410,"Preview expired"),"screenshot");
  assert.equal(expired.status,410);assert.equal(expired.failure_code,"session_expired");
  const timeout=regionPreviewFailure(new CaptureFailure("screenshot","timeout"),"screenshot");
  assert.equal(timeout.status,504);assert.equal(timeout.failure_code,"timeout");
});
