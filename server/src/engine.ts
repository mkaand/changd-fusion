import { randomUUID, createHash } from "node:crypto";
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
import { openValues } from "./vault.js";
import { AttentionFailure } from "./attention.js";
import { publicFailure } from "./errors.js";

async function queueNotification(c: any, monitor: any, eventId: string, fingerprint: string) {
  if (!monitor.notification_enabled) {
    await c.query("UPDATE fusion_events SET notification_state='disabled',notification_fingerprint=$2 WHERE id=$1", [eventId, fingerprint]);
    return;
  }
  if (monitor.muted_until && new Date(monitor.muted_until).getTime() > Date.now()) {
    await c.query("UPDATE fusion_events SET notification_state='muted',notification_fingerprint=$2 WHERE id=$1", [eventId, fingerprint]);
    return;
  }
  const channels = await c.query("SELECT mc.channel_id FROM fusion_monitor_channels mc JOIN fusion_channels ch ON ch.id=mc.channel_id WHERE mc.monitor_id=$1 AND ch.enabled AND ch.user_id=$2", [monitor.id, monitor.user_id]);
  if (!channels.rowCount) {
    await c.query("UPDATE fusion_events SET notification_state='not_requested',notification_fingerprint=$2 WHERE id=$1", [eventId, fingerprint]);
    return;
  }
  if (monitor.notification_mode === "digest") {
    for (const row of channels.rows) await c.query(
      "INSERT INTO fusion_notification_digests(monitor_id,channel_id,first_event_at,last_event_at,event_count,latest_event_id,due_at) VALUES($1,$2,now(),now(),1,$3,now()+$4*interval '1 second') ON CONFLICT(monitor_id,channel_id) DO UPDATE SET last_event_at=now(),event_count=fusion_notification_digests.event_count+1,latest_event_id=EXCLUDED.latest_event_id",
      [monitor.id, row.channel_id, eventId, monitor.digest_window_seconds],
    );
    await c.query("UPDATE fusion_events SET notification_state='digest_pending',notification_fingerprint=$2 WHERE id=$1", [eventId, fingerprint]);
    return;
  }
  const duplicate = await c.query("SELECT 1 FROM fusion_events e JOIN fusion_outbox o ON o.event_id=e.id WHERE e.monitor_id=$1 AND e.notification_fingerprint=$2 AND o.status IN ('pending','sending','sent') AND e.created_at>now()-interval '24 hours' LIMIT 1", [monitor.id, fingerprint]);
  if (duplicate.rowCount) {
    await c.query("UPDATE fusion_events SET notification_state='duplicate_suppressed',notification_fingerprint=$2 WHERE id=$1", [eventId, fingerprint]);
    return;
  }
  if (monitor.notification_cooldown_seconds > 0) {
    const recent = await c.query("SELECT 1 FROM fusion_outbox o JOIN fusion_events e ON e.id=o.event_id WHERE e.monitor_id=$1 AND o.status IN ('pending','sending','sent') AND e.created_at>now()-$2*interval '1 second' LIMIT 1", [monitor.id, monitor.notification_cooldown_seconds]);
    if (recent.rowCount) {
      await c.query("UPDATE fusion_events SET notification_state='cooldown',notification_fingerprint=$2 WHERE id=$1", [eventId, fingerprint]);
      return;
    }
  }
  await c.query("INSERT INTO fusion_outbox(event_id,channel_id) SELECT $1,mc.channel_id FROM fusion_monitor_channels mc JOIN fusion_channels ch ON ch.id=mc.channel_id WHERE mc.monitor_id=$2 AND ch.enabled AND ch.user_id=$3 ON CONFLICT DO NOTHING", [eventId, monitor.id, monitor.user_id]);
  await c.query("UPDATE fusion_events SET notification_state='queued',notification_fingerprint=$2 WHERE id=$1", [eventId, fingerprint]);
}
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
      "SELECT * FROM fusion_monitors WHERE id=$1 AND enabled AND NOT paused AND ($2 OR next_run<=now())",
      [id, !!options.force],
    );
    if (!result.rowCount) return false;
    const m: Monitor = result.rows[0];
    const started = Date.now();
    await c.query("UPDATE fusion_monitors SET last_run=now() WHERE id=$1", [
      id,
    ]);
    try {
      if ((m.browser_steps ?? []).some((s) => s.action === "fill_private")) {
        const vault = (
          await c.query(
            "SELECT * FROM fusion_monitor_vault WHERE monitor_id=$1 AND user_id=$2",
            [id, m.user_id],
          )
        ).rows[0];
        if (!vault)
          throw new AttentionFailure(
            "authentication_required",
            "confirmed",
            "Configure private values before running this workflow.",
          );
        m.private_values = openValues(vault, cfg.CHANNEL_KEY, m);
      }
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
          "INSERT INTO fusion_events(monitor_id,before_id,after_id,text_changed,visual_changed,visual_percent,diff_screenshot,text_diff,status,dimension_changed,before_dimensions,after_dimensions,execution_ms,warning_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id",
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
            Date.now() - started,
            current.warning ?? null,
          ],
        );
        await c.query(
          "UPDATE fusion_monitors SET latest_capture_id=$2,baseline_id=CASE WHEN $3 THEN $2 ELSE baseline_id END,last_percent=$4,last_dimension_change=$5,last_run=now(),next_run=now()+interval_seconds*interval '1 second',failure_count=0,last_error=null,last_success_at=now(),last_change_at=CASE WHEN $6='changed' THEN now() ELSE last_change_at END,monitor_state=$6,execution_ms=$7,warning_code=$8 WHERE id=$1",
          [
            id,
            captureId,
            status !== "unchanged",
            visual?.percent ?? null,
            visual?.dimensionChanged ?? false,
            status === "baseline" ? "healthy" : status,
            Date.now() - started,
            current.warning ?? null,
          ],
        );
        if (status === "changed")
          await queueNotification(c, m, event.rows[0].id, createHash("sha256").update(JSON.stringify({ text: text.parts, visual: visual?.percent ?? null, dimensions: visual?.dimensionChanged ?? false })).digest("hex"));
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    } catch (e) {
      for (const file of saved) await storage.remove(file);
      const state =
        e instanceof AttentionFailure
          ? e.state
          : m.failure_count + 1 >= 3
            ? "persistent_failure"
            : "temporary_failure";
      const warning = e instanceof AttentionFailure ? e.confidence : null;
      const shouldNotify =
        state !== m.monitor_state &&
        (state === "persistent_failure"
          ? m.notify_failures
          : e instanceof AttentionFailure && m.notify_attention);
      await c.query("BEGIN");
      try {
        await c.query(
          "UPDATE fusion_monitors SET failure_count=failure_count+1,last_error=$2,last_run=now(),next_run=now()+greatest($5,least(3600,30*power(2,least(failure_count,7))))*interval '1 second',monitor_state=$3,execution_ms=$4,warning_code=$6 WHERE id=$1",
          [
            id,
            publicFailure(e),
            state,
            Date.now() - started,
            e instanceof AttentionFailure ? 900 : 0,
            warning,
          ],
        );
        const event = await c.query(
          "INSERT INTO fusion_events(monitor_id,status,error,attention_state,warning_code,execution_ms) VALUES($1,'failed',$2,$3,$4,$5) RETURNING id",
          [id, publicFailure(e), state, warning, Date.now() - started],
        );
        if (shouldNotify)
          await queueNotification(c, m, event.rows[0].id, createHash("sha256").update(JSON.stringify({ state, error: publicFailure(e) })).digest("hex"));
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK");
        throw error;
      }
    }
    return true;
  } finally {
    let clean = false;
    try {
      if (locked)
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          id,
        ]);
      if (shared) await c.query("SELECT pg_advisory_unlock_shared(741902)");
      clean = true;
    } finally {
      // An uncertain unlock must destroy the session, releasing every advisory lock.
      c.release(!clean);
    }
  }
}
export async function retainHistory(pool: Pool, cfg: Config) {
  // Serialize cleanup with capture using a shared/exclusive global advisory lock.
  const guard = await pool.connect();
  let locked: boolean;
  try {
    locked = (await guard.query("SELECT pg_try_advisory_lock(741902) locked"))
      .rows[0].locked;
  } catch (error) {
    guard.release(true);
    throw error;
  }
  if (!locked) {
    guard.release();
    return;
  }
  try {
    await guard.query(
      "DELETE FROM fusion_sessions WHERE expires_at<now()-interval '1 day' OR revoked_at<now()-interval '1 day'",
    );
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
    let clean = false;
    try {
      await guard.query("SELECT pg_advisory_unlock(741902)");
      clean = true;
    } finally {
      guard.release(!clean);
    }
  }
}
