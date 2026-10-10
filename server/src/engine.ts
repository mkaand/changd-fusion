import { randomUUID } from "node:crypto";
import { type Pool } from "./db.js";
import { capture, type Monitor, type Capture } from "./capture.js";
import {
  compareText,
  pixelmatchComparator,
  type VisualComparator,
} from "./comparison.js";
import type { Config } from "./config.js";
import { Storage } from "./storage.js";
import { pngDimensions } from "./image.js";
import { publicFailure } from "./errors.js";
export async function runMonitor(
  pool: Pool,
  cfg: Config,
  id: string,
  options: {
    capture?: typeof capture;
    comparator?: VisualComparator;
    force?: boolean;
  } = {},
) {
  const c = await pool.connect();
  const storage = new Storage(cfg.DATA_DIR);
  let locked = false,
    shared = false;
  const saved: string[] = [];
  try {
    shared = (
      await c.query("SELECT pg_try_advisory_lock_shared(741902) locked")
    ).rows[0].locked;
    if (!shared) return false;
    locked = (
      await c.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [id],
      )
    ).rows[0].locked;
    if (!locked) return false;
    const result = await c.query(
      "SELECT * FROM fusion_monitors WHERE id=$1 AND enabled AND ($2 OR next_run<=now())",
      [id, !!options.force],
    );
    if (!result.rowCount) return false;
    const m: Monitor = result.rows[0];
    try {
      const current: Capture = await (options.capture ?? capture)(m, cfg);
      if (
        (m.text_enabled && current.text === null) ||
        (m.visual_enabled && !current.screenshot)
      )
        throw Error("Incomplete capture");
      if (current.screenshot)
        pngDimensions(current.screenshot, {
          width: cfg.MAX_CAPTURE_WIDTH,
          height: cfg.MAX_CAPTURE_HEIGHT,
          pixels: cfg.MAX_CAPTURE_PIXELS,
        });
      const before = m.baseline_id
        ? (
            await c.query(
              "SELECT * FROM fusion_captures WHERE id=$1 AND monitor_id=$2",
              [m.baseline_id, id],
            )
          ).rows[0]
        : null;
      const text =
        before && m.text_enabled
          ? compareText(before.text_content ?? "", current.text ?? "")
          : { changed: false, parts: [] };
      const visual =
        before && m.visual_enabled
          ? (options.comparator ?? pixelmatchComparator).compare(
              await storage.read(before.screenshot),
              current.screenshot!,
              m.visual_threshold,
              Number(m.pixel_threshold),
            )
          : null;
      const image = current.screenshot
        ? await storage.save(current.screenshot)
        : null;
      if (image) saved.push(image);
      const diff =
        visual?.diff && Number(visual.percent) > 0
          ? await storage.save(visual.diff)
          : null;
      if (diff) saved.push(diff);
      const captureId = randomUUID(),
        status = !before
          ? "baseline"
          : text.changed || visual?.changed
            ? "changed"
            : "unchanged";
      await c.query("BEGIN");
      try {
        await c.query(
          "INSERT INTO fusion_captures(id,monitor_id,text_content,screenshot) VALUES($1,$2,$3,$4)",
          [captureId, id, current.text, image],
        );
        const event = await c.query(
          "INSERT INTO fusion_events(monitor_id,before_id,after_id,text_changed,visual_changed,visual_percent,diff_screenshot,text_diff,status,dimension_changed,before_dimensions,after_dimensions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id",
          [
            id,
            before?.id ?? null,
            captureId,
            text.changed,
            visual?.changed ?? false,
            visual?.percent ?? null,
            diff,
            JSON.stringify(text.parts),
            status,
            visual?.dimensionChanged ?? false,
            visual ? JSON.stringify(visual.beforeDimensions) : null,
            visual ? JSON.stringify(visual.afterDimensions) : null,
          ],
        );
        await c.query(
          "UPDATE fusion_monitors SET latest_capture_id=$2,baseline_id=CASE WHEN $3 THEN $2 ELSE baseline_id END,last_percent=$4,last_dimension_change=$5,last_run=now(),next_run=now()+interval_seconds*interval '1 second',failure_count=0,last_error=null WHERE id=$1",
          [
            id,
            captureId,
            status !== "unchanged",
            visual?.percent ?? null,
            visual?.dimensionChanged ?? false,
          ],
        );
        if (status === "changed")
          await c.query(
            "INSERT INTO fusion_outbox(event_id,channel_id) SELECT $1,mc.channel_id FROM fusion_monitor_channels mc JOIN fusion_channels ch ON ch.id=mc.channel_id WHERE mc.monitor_id=$2 AND ch.enabled AND ch.user_id=$3 ON CONFLICT DO NOTHING",
            [event.rows[0].id, id, m.user_id],
          );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    } catch (e) {
      for (const file of saved) await storage.remove(file);
      await c.query("BEGIN");
      try {
        await c.query(
          "UPDATE fusion_monitors SET failure_count=failure_count+1,last_error=$2,last_run=now(),next_run=now()+least(3600,30*power(2,least(failure_count,7)))*interval '1 second' WHERE id=$1",
          [id, publicFailure(e)],
        );
        await c.query(
          "INSERT INTO fusion_events(monitor_id,status,error) VALUES($1,'failed',$2)",
          [id, publicFailure(e)],
        );
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      }
    }
    return true;
  } finally {
    if (locked)
      await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [id]);
    if (shared) await c.query("SELECT pg_advisory_unlock_shared(741902)");
    c.release();
  }
}
export async function retainHistory(pool: Pool, cfg: Config) {
  // Serialize cleanup with capture using a shared/exclusive global advisory lock.
  const guard = await pool.connect();
  const locked = (
    await guard.query("SELECT pg_try_advisory_lock(741902) locked")
  ).rows[0].locked;
  if (!locked) {
    guard.release();
    return;
  }
  try {
    // Retain events with pending/failed deliveries, and captures used by current baselines/latest captures.
    await guard.query(
      "DELETE FROM fusion_events e WHERE created_at<now()-$1*interval '1 day' AND NOT EXISTS(SELECT 1 FROM fusion_outbox o WHERE o.event_id=e.id AND o.status<>'sent')",
      [cfg.HISTORY_DAYS],
    );
    await guard.query(
      "DELETE FROM fusion_captures c WHERE NOT EXISTS(SELECT 1 FROM fusion_events e WHERE e.before_id=c.id OR e.after_id=c.id) AND NOT EXISTS(SELECT 1 FROM fusion_monitors m WHERE m.baseline_id=c.id OR m.latest_capture_id=c.id)",
    );
    const refs = await guard.query(
      "SELECT screenshot AS name FROM fusion_captures WHERE screenshot IS NOT NULL UNION SELECT diff_screenshot FROM fusion_events WHERE diff_screenshot IS NOT NULL",
    );
    const keep = new Set(refs.rows.map((r) => r.name));
    const storage = new Storage(cfg.DATA_DIR);
    // A grace period prevents deleting a capture saved by another active worker before its DB commit.
    const { stat } = await import("node:fs/promises");
    for (const name of await storage.files())
      if (
        !keep.has(name) &&
        Date.now() - (await stat(await storage.file(name))).mtimeMs > 3600000
      )
        await storage.remove(name);
  } finally {
    await guard.query("SELECT pg_advisory_unlock(741902)");
    guard.release();
  }
}
