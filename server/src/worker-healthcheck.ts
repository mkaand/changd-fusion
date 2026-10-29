import {
  probeWorkerReadiness,
  WORKER_READINESS_PATH,
} from "./worker-readiness.js";

const result = probeWorkerReadiness(
  WORKER_READINESS_PATH,
  process.env.APP_COMMIT ?? "",
);
const output = result.ready && result.marker
  ? {
      ready: true,
      code: result.code,
      checkedAtMs: result.checkedAtMs,
      schema: result.marker.schema,
      release: result.marker.release,
      instanceId: result.marker.instanceId,
      pid: result.marker.pid,
      processStartTicks: result.marker.processStartTicks,
      bootId: result.marker.bootId,
      phase: result.marker.phase,
      operation: result.marker.operation,
      updatedAtMs: result.marker.updatedAtMs,
      validUntilMs: result.marker.validUntilMs,
      consecutiveFailures: result.marker.consecutiveFailures,
      sequence: result.marker.sequence,
    }
  : { ready: false, code: result.code, checkedAtMs: result.checkedAtMs };
console.log(JSON.stringify(output));
if (!result.ready) process.exitCode = 1;
