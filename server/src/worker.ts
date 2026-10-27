import type { Pool } from "./db.js";
import type { Config } from "./config.js";
import { capture } from "./capture.js";
import { runMonitor, type CaptureFailureDiagnostic } from "./engine.js";
import { dispatch } from "./outbox.js";
import { deliver } from "./notifications.js";
import { acquireChromiumLease, cancelInteractivePriorityIntent, createInteractivePriorityIntent } from "./chromium-capacity.js";
import { CaptureFailure } from "./errors.js";
import { isWorkerFatalError } from "./errors.js";
export async function workerCycle(
  pool: Pool,
  cfg: Config,
  options: {
    capture?: typeof capture;
    send?: typeof deliver;
    stopped?: () => boolean;
    onFailure?: (diagnostic: CaptureFailureDiagnostic) => void;
  } = {},
) {
  // A different replica may still be finishing a running manual capture.
  // Claim the same monitor lock before cancelling abandoned/disabled work;
  // never relabel a live run while its capture transaction can still commit.
  const cancelled = await pool.query("UPDATE fusion_manual_runs r SET status='cancelled',updated_at=now() FROM fusion_monitors m WHERE m.id=r.monitor_id AND r.status IN ('queued','running') AND (NOT m.enabled OR m.paused) AND pg_try_advisory_xact_lock(hashtextextended(m.id::text,0)) RETURNING r.priority_intent_id");
  for (const run of cancelled.rows) await cancelInteractivePriorityIntent(pool, run.priority_intent_id);
  const manual = await pool.query<{ run_id: string; monitor_id: string; user_id: string; priority_intent_id: string; kind: string; text_source: string; text_enabled: boolean; visual_enabled: boolean }>(
    "SELECT r.id AS run_id,r.monitor_id,r.user_id,r.priority_intent_id,m.kind,m.text_source,m.text_enabled,m.visual_enabled FROM fusion_manual_runs r JOIN fusion_monitors m ON m.id=r.monitor_id WHERE r.status IN ('queued','running') ORDER BY (m.kind='browser' AND (m.visual_enabled OR (m.text_enabled AND m.text_source<>'jina'))),r.created_at LIMIT 5",
  );
  const due = await pool.query(
    "SELECT id,kind,text_source,text_enabled,visual_enabled FROM fusion_monitors WHERE enabled AND NOT paused AND next_run<=now() AND NOT EXISTS (SELECT 1 FROM fusion_manual_runs r WHERE r.monitor_id=fusion_monitors.id AND r.status IN ('queued','running')) ORDER BY next_run LIMIT 5",
  );
  const work = [
    ...manual.rows.map((run) => ({ ...run, id: run.monitor_id, manualRunId: run.run_id, priorityIntentId: run.priority_intent_id })),
    ...due.rows.map((monitor) => ({ ...monitor, manualRunId: undefined as string | undefined, priorityIntentId: undefined as string | undefined })),
  ];
  let next = 0;
  const defer = async (monitor: { id: string; manualRunId?: string }) => {
    if (!monitor.manualRunId) await pool.query("UPDATE fusion_monitors SET next_run=now()+interval '5 seconds' WHERE id=$1 AND next_run<=now()", [monitor.id]);
  };
  await Promise.all(
    Array.from({ length: cfg.CHROMIUM_CONCURRENCY }, async () => {
      while (next < work.length && !options.stopped?.()) {
        const monitor = work[next++];
        const usesChromium = monitor.kind === "browser" && (monitor.visual_enabled || (monitor.text_enabled && monitor.text_source !== "jina"));
        if (monitor.manualRunId && usesChromium) {
          const intent = await pool.query("SELECT 1 FROM fusion_chromium_priority_intents WHERE id=$1 AND cancelled_at IS NULL AND expires_at>now()", [monitor.priorityIntentId]);
          if (!intent.rowCount) {
            try {
              monitor.priorityIntentId = await createInteractivePriorityIntent(pool, monitor.user_id, "manual", monitor.id);
              const refreshed = await pool.query("UPDATE fusion_manual_runs SET priority_intent_id=$2 WHERE id=$1 AND status IN ('queued','running') RETURNING id", [monitor.manualRunId, monitor.priorityIntentId]);
              if (!refreshed.rowCount) {
                await cancelInteractivePriorityIntent(pool, monitor.priorityIntentId);
                continue;
              }
            } catch (error) {
              if (error instanceof CaptureFailure && ["capacity_busy", "capacity_queue_full", "scheduled_recovery"].includes(error.code)) continue;
              throw error;
            }
          }
        }
        let capacity = null;
        try {
          capacity = usesChromium ? await acquireChromiumLease(pool, {
              workload: monitor.manualRunId ? "preview" : "capture",
              slots: cfg.CHROMIUM_CONCURRENCY,
              // Do not hold up HTTP/text monitoring or notification delivery
              // while another interactive session owns the browser.
              waitMs: 0,
              observeInteractivePriority: !monitor.manualRunId,
              priorityIntentId: monitor.priorityIntentId,
            }) : null;
        } catch (error) {
          // Quarantined browser capacity must not stop non-browser checks or
          // outbox delivery. It is an infrastructure condition, not site health.
          if (error instanceof CaptureFailure && error.code === "cleanup_timeout") { await defer(monitor); continue; }
          throw error;
        }
        // Waiting scheduled work is coalesced, without fake skipped events.
        if (usesChromium && !capacity) { await defer(monitor); continue; }
        let fatalCleanup = false;
        try {
          await runMonitor(pool, cfg, monitor.id, {
            capture: (monitor, config) => (options.capture ?? capture)(monitor, config, undefined, capacity?.signal),
            onFailure: options.onFailure,
            force: Boolean(monitor.manualRunId),
            manualRunId: monitor.manualRunId,
            signal: capacity?.signal,
          });
        } catch (error) {
          fatalCleanup = isWorkerFatalError(error);
          throw error;
        } finally {
          if (!fatalCleanup) await capacity?.release();
          if (!fatalCleanup && monitor.manualRunId && !capacity) await cancelInteractivePriorityIntent(pool, monitor.priorityIntentId);
        }
      }
    }),
  );
  await dispatch(pool, cfg, options.send, { stopped: options.stopped });
}
