export const monitorStates = [
  "healthy",
  "changed",
  "unchanged",
  "waiting_baseline",
  "temporary_failure",
  "persistent_failure",
  "authentication_required",
  "challenge_detected",
  "paused",
  "disabled",
];
export function monitorState(m: any): string {
  return !m.enabled
    ? "disabled"
    : m.paused
      ? "paused"
      : (m.monitor_state ??
        (m.last_error
          ? "temporary_failure"
          : m.baseline_id
            ? "healthy"
            : "waiting_baseline"));
}
export function filterMonitors(monitors: any[], query: string, state?: string) {
  return monitors.filter(
    (m) =>
      (!state || monitorState(m) === state) &&
      `${m.name} ${m.url}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
}
