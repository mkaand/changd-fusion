import { type Pool } from "./db.js";
import type { Config } from "./config.js";
import { decrypt } from "./crypto.js";
import { deliver, safeTextSummary, type EventMessage } from "./notifications.js";
import { Storage } from "./storage.js";
export async function dispatch(
  pool: Pool,
  cfg: Config,
  send: typeof deliver = deliver,
  options: { stopped?: () => boolean; onProgress?: () => void } = {},
) {
  const digestConnection = await pool.connect();
  try {
    await digestConnection.query("BEGIN");
    const due = await digestConnection.query("SELECT * FROM fusion_notification_digests WHERE due_at<=now() FOR UPDATE SKIP LOCKED");
    for (const row of due.rows) {
      options.onProgress?.();
      const event = await digestConnection.query("INSERT INTO fusion_events(monitor_id,status,metadata,notification_state) VALUES($1,'digest',$2,'queued') RETURNING id", [row.monitor_id, JSON.stringify({ digest_count: row.event_count, period_start: row.first_event_at, period_end: row.last_event_at })]);
      await digestConnection.query("INSERT INTO fusion_outbox(event_id,channel_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [event.rows[0].id, row.channel_id]);
      await digestConnection.query("DELETE FROM fusion_notification_digests WHERE monitor_id=$1 AND channel_id=$2", [row.monitor_id, row.channel_id]);
    }
    await digestConnection.query("COMMIT");
  } catch (error) {
    await digestConnection.query("ROLLBACK");
    throw error;
  } finally { digestConnection.release(); }
  const candidates = await pool.query(
    "SELECT id FROM fusion_outbox WHERE status IN ('pending','sending') AND next_attempt<=now() ORDER BY next_attempt LIMIT 10",
  );
  for (const { id } of candidates.rows) {
    if (options.stopped?.()) break;
    options.onProgress?.();
    const c = await pool.connect();
    let locked = false;
    try {
      locked = (
        await c.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,1)) locked",
          [id],
        )
      ).rows[0].locked;
      if (!locked) continue;
      const r = await c.query(
        `SELECT o.*,ch.provider,ch.config,ch.enabled,m.name,m.id monitor_id,e.created_at checked_at,e.status event_type,e.text_changed,e.visual_changed,e.visual_percent,e.dimension_changed,e.before_dimensions,e.after_dimensions,e.text_diff,e.metadata,e.diff_screenshot,e.attention_state,e.error,e.http_status,e.http_status_changed,
    b.screenshot before_image,b.http_status before_http_status,a.screenshot after_image FROM fusion_outbox o JOIN fusion_channels ch ON ch.id=o.channel_id JOIN fusion_events e ON e.id=o.event_id
    JOIN fusion_monitors m ON m.id=e.monitor_id LEFT JOIN fusion_captures b ON b.id=e.before_id LEFT JOIN fusion_captures a ON a.id=e.after_id
    WHERE o.id=$1 AND o.status IN ('pending','sending') AND o.next_attempt<=now() AND ch.user_id=m.user_id`,
        [id],
      );
      if (!r.rowCount) continue;
      const row = r.rows[0];
      if (!row.enabled) {
        await c.query(
          "UPDATE fusion_outbox SET status='failed',last_error='Channel disabled' WHERE id=$1",
          [id],
        );
        continue;
      }
      if (
        row.provider === "telegram" &&
        row.config.preview_test_required &&
        !row.config.preview_verified &&
        row.event_type !== "test"
      ) {
        await c.query(
          "UPDATE fusion_outbox SET status='failed',last_error='Test notification required' WHERE id=$1",
          [id],
        );
        continue;
      }
      await c.query(
        "UPDATE fusion_outbox SET status='sending',attempts=attempts+1,next_attempt=now()+interval '2 minutes' WHERE id=$1",
        [id],
      );
      const event: EventMessage = {
        id: row.event_id,
        name: row.name,
        monitorId: row.monitor_id,
        textChanged: row.text_changed,
        visualChanged: row.visual_changed,
        percent: row.visual_percent,
        dimensionChanged: row.dimension_changed,
        beforeDimensions: row.before_dimensions,
        afterDimensions: row.after_dimensions,
        textSummary: safeTextSummary(Array.isArray(row.text_diff) ? row.text_diff : []),
        link: new URL("/jobs/" + row.monitor_id, cfg.PUBLIC_URL).href,
        attentionState: row.attention_state,
        attentionMessage: row.error,
        checkedAt: row.checked_at,
        eventType: row.event_type,
        digestCount: row.metadata?.digest_count,
        digestStart: row.metadata?.period_start,
        digestEnd: row.metadata?.period_end,
        httpStatus: row.http_status,
        previousHttpStatus: row.before_http_status,
        httpStatusChanged: row.http_status_changed,
        attempt: row.attempts + 1,
        imageLabels: (["before", "after", "diff"] as const).filter((_, i) =>
          Boolean([row.before_image, row.after_image, row.diff_screenshot][i]),
        ),
        images: [row.before_image, row.after_image, row.diff_screenshot].filter(
          Boolean,
        ),
      };
      try {
        options.onProgress?.();
        await send(
          row.provider,
          decrypt(row.config.encrypted, cfg.CHANNEL_KEY),
          event,
          new Storage(cfg.DATA_DIR),
        );
        await c.query(
          "UPDATE fusion_outbox SET status='sent',delivered_at=now(),last_error=null WHERE id=$1",
          [id],
        );
        if (
          row.provider === "telegram" &&
          row.event_type === "test" &&
          row.config.preview_test_required
        ) {
          // An in-flight test for old credentials cannot authorize newly edited credentials.
          await c.query(
            "UPDATE fusion_channels SET config=jsonb_set(config,'{preview_verified}','true'::jsonb) WHERE id=$1 AND config->>'encrypted'=$2 AND config->>'preview_test_required'='true'",
            [row.channel_id, row.config.encrypted],
          );
        }
      } catch {
        await c.query(
          "UPDATE fusion_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,last_error='Provider delivery failed',next_attempt=now()+least(3600,30*power(2,attempts))*interval '1 second' WHERE id=$1",
          [id],
        );
      }
      options.onProgress?.();
    } finally {
      let clean = false;
      try {
        if (locked)
          await c.query("SELECT pg_advisory_unlock(hashtextextended($1,1))", [
            id,
          ]);
        clean = true;
      } finally {
        c.release(!clean);
      }
    }
  }
}
