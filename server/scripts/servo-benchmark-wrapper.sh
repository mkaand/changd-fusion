#!/bin/sh
set -u

metrics_path=$1
shift
started_ns=$(date +%s%N)
start_cpu_usec=$(awk '$1 == "usage_usec" { print $2 }' /sys/fs/cgroup/cpu.stat)
start_cpu_periods=$(awk '$1 == "nr_periods" { print $2 }' /sys/fs/cgroup/cpu.stat)
start_cpu_throttled_periods=$(awk '$1 == "nr_throttled" { print $2 }' /sys/fs/cgroup/cpu.stat)
start_cpu_throttled_usec=$(awk '$1 == "throttled_usec" { print $2 }' /sys/fs/cgroup/cpu.stat)
rss_peak_path="${metrics_path}.rss"
printf '0\n' > "$rss_peak_path"

"$@" &
child_pid=$!
(
  while kill -0 "$child_pid" 2>/dev/null; do
    current_rss=$(awk '/^VmRSS:/ { total += $2 } END { print total * 1024 }' /proc/[0-9]*/status 2>/dev/null)
    peak_rss=$(cat "$rss_peak_path")
    if [ "${current_rss:-0}" -gt "${peak_rss:-0}" ]; then
      printf '%s\n' "$current_rss" > "$rss_peak_path"
    fi
    sleep 0.1
  done
) &
sampler_pid=$!
wait "$child_pid"
exit_code=$?
wait "$sampler_pid" 2>/dev/null || true

finished_ns=$(date +%s%N)
end_cpu_usec=$(awk '$1 == "usage_usec" { print $2 }' /sys/fs/cgroup/cpu.stat)
end_cpu_periods=$(awk '$1 == "nr_periods" { print $2 }' /sys/fs/cgroup/cpu.stat)
end_cpu_throttled_periods=$(awk '$1 == "nr_throttled" { print $2 }' /sys/fs/cgroup/cpu.stat)
end_cpu_throttled_usec=$(awk '$1 == "throttled_usec" { print $2 }' /sys/fs/cgroup/cpu.stat)
peak_rss_bytes=$(cat "$rss_peak_path")
peak_cgroup_bytes=$(cat /sys/fs/cgroup/memory.peak)
rm -f "$rss_peak_path"
remaining=0
for process_path in /proc/[0-9]*; do
  process_id=${process_path##*/}
  if [ "$process_id" != "1" ]; then
    remaining=$((remaining + 1))
  fi
done

duration_ms=$(( (finished_ns - started_ns) / 1000000 ))
cpu_ms=$(( (end_cpu_usec - start_cpu_usec) / 1000 ))
cpu_periods=$(( ${end_cpu_periods:-0} - ${start_cpu_periods:-0} ))
cpu_throttled_periods=$(( ${end_cpu_throttled_periods:-0} - ${start_cpu_throttled_periods:-0} ))
cpu_throttled_ms=$(( (${end_cpu_throttled_usec:-0} - ${start_cpu_throttled_usec:-0}) / 1000 ))
printf '{"commandWallMs":%s,"cpuMs":%s,"cpuPeriods":%s,"cpuThrottledPeriods":%s,"cpuThrottledMs":%s,"peakProcessRssBytes":%s,"peakCgroupBytes":%s,"exitCode":%s,"remainingProcesses":%s}\n' \
  "$duration_ms" "$cpu_ms" "$cpu_periods" "$cpu_throttled_periods" "$cpu_throttled_ms" "$peak_rss_bytes" "$peak_cgroup_bytes" "$exit_code" "$remaining" > "$metrics_path"

exit "$exit_code"
