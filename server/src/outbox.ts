import { type Pool } from "./db.js";
import type { Config } from "./config.js";
import { decrypt } from "./crypto.js";
import { deliver, type EventMessage } from "./notifications.js";
import { Storage } from "./storage.js";
export async function dispatch(
  pool: Pool,
  cfg: Config,
  send: typeof deliver = deliver,
  options: { stopped?: () => boolean } = {},
) {
  const candidates = await pool.query(
    "SELECT id FROM fusion_outbox WHERE status IN ('pending','sending') AND next_attempt<=now() ORDER BY next_attempt LIMIT 10",
  );
  for (const { id } of candidates.rows) {
    if (options.stopped?.()) break;
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
        `SELECT o.*,ch.provider,ch.config,ch.enabled,m.name,m.id monitor_id,e.text_changed,e.visual_changed,e.visual_percent,e.dimension_changed,e.before_dimensions,e.after_dimensions,e.text_diff,e.diff_screenshot,
    b.screenshot before_image,a.screenshot after_image FROM fusion_outbox o JOIN fusion_channels ch ON ch.id=o.channel_id JOIN fusion_events e ON e.id=o.event_id
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
        textSummary: row.text_diff
          .filter((p: any) => p.added || p.removed)
          .map((p: any) => (p.added ? "+ " : "- ") + p.value)
          .join("\n")
          .slice(0, 3000),
        link: new URL("/jobs/" + row.monitor_id, cfg.PUBLIC_URL).href,
        images: [row.before_image, row.after_image, row.diff_screenshot].filter(
          Boolean,
        ),
      };
      try {
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
      } catch {
        await c.query(
          "UPDATE fusion_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,last_error='Provider delivery failed',next_attempt=now()+least(3600,30*power(2,attempts))*interval '1 second' WHERE id=$1",
          [id],
        );
      }
    } finally {
      if (locked)
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1,1))", [
          id,
        ]);
      c.release();
    }
  }
}
