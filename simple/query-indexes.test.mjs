import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openSimpleDatabase, SCHEMA_VERSION } from './db.mjs';

test('compatible SQLite indexes serve authorization and due-work queries', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'fusion-indexes-'));
  let db;
  try {
    const filename=path.join(dir,'fusion.sqlite');
    db=openSimpleDatabase(filename);
    assert.equal(SCHEMA_VERSION,1);
    const plan=(sql,values)=>db.prepare('EXPLAIN QUERY PLAN '+sql).all(...values).map(row=>row.detail).join(' | ');
    const capture='SELECT 1 FROM captures c JOIN monitors m ON m.id=c.monitor_id WHERE m.user_id=? AND c.screenshot=?';
    const diff="SELECT 1 FROM events e JOIN monitors m ON m.id=e.monitor_id WHERE m.user_id=? AND json_extract(e.payload,'$.diff_screenshot')=?";
    const delivery="SELECT o.*,c.payload AS channel,e.payload AS event,m.payload AS monitor FROM outbox o JOIN channels c ON c.id=o.channel_id JOIN events e ON e.id=o.event_id JOIN monitors m ON m.id=e.monitor_id WHERE o.status IN ('pending','failed') AND o.next_attempt<=? AND o.attempts<5 ORDER BY o.next_attempt LIMIT 10";
    const digest='SELECT * FROM notification_digests WHERE due_at<=? ORDER BY due_at LIMIT 30';
    const fingerprint="SELECT 1 FROM events e JOIN outbox o ON o.event_id=e.id WHERE e.monitor_id=? AND json_extract(e.payload,'$.notification_fingerprint')=? AND o.status IN ('pending','sent') AND e.created_at>? LIMIT 1";
    assert.match(plan(capture,['owner','image']),/captures_screenshot_auth/);
    assert.match(plan(diff,['owner','image']),/events_diff_screenshot_auth/);
    assert.match(plan(delivery,[Date.now()]),/outbox_delivery_due/);
    assert.match(plan(digest,[Date.now()]),/notification_digests_due/);
    assert.match(plan(fingerprint,['monitor','fingerprint',Date.now()]),/events_notification_fingerprint/);
    db.close();db=openSimpleDatabase(filename);
    assert.equal(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get().value,'1');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,2);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  } finally {db?.close();rmSync(dir,{recursive:true,force:true});}
});
