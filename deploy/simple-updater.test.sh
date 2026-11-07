#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=deploy/simple-updater.sh
source "$ROOT/deploy/simple-updater.sh"

PASS=0
fail() { printf 'not ok - %s\n' "$1"; exit 1; }
ok() { PASS=$((PASS+1)); printf 'ok %d - %s\n' "$PASS" "$1"; }
assert_eq() { [[ "$1" == "$2" ]] || fail "expected [$2], got [$1]"; }

OLD="sha256:$(printf '1%.0s' {1..64})"
NEW="sha256:$(printf '2%.0s' {1..64})"
BAD="sha256:$(printf '3%.0s' {1..64})"
BASELINE='{"integrity":"ok","schema":"1","counts":{"users":1,"monitors":2,"captures":3,"events":4,"channels":1}}'

setup_orchestrator() {
  TEST_DIR="$(mktemp -d)"
  STATE_FILE="$TEST_DIR/state.json"
  STATE="$(jq -n --arg digest "$OLD" --argjson baseline "$BASELINE" \
    '{format:1,healthy_digest:$digest,previous_digest:null,version:"0.4.1",failed_digests:[],baseline:$baseline}')"
  printf '%s\n' "$STATE" >"$STATE_FILE"
  FUSION_PROJECT_DIR="$TEST_DIR"
  FUSION_MIN_FREE_MB=1
  FUSION_HEALTH_URL=http://127.0.0.1:8127/api/v1/health
  MUTATIONS="$TEST_DIR/mutations"
  : >"$MUTATIONS"
  compose_preflight() { :; }
  verify_contract() { :; }
  check_disk() { :; }
  load_state() { STATE="$(cat "$STATE_FILE")"; }
  current_digest() { printf '%s\n' "$OLD"; }
  docker() { [[ "$1" == pull ]]; }
  image_metadata() { jq -n --arg digest "$1" '{digest:$digest,revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",version:"0.4.2",schema:"1"}'; }
  trusted_master_sha() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'; }
  sqlite_baseline() { printf '%s\n' "$BASELINE"; }
  apply_digest() { printf '%s\n' "$1" >>"$MUTATIONS"; }
  wait_healthy() { :; }
  cleanup_old_images() { :; }
  notify() { :; }
}

(
  setup_orchestrator
  discover_digest() { printf '%s\n' "$OLD"; }
  run_update
  [[ ! -s "$MUTATIONS" ]] || fail no-op-mutated
  assert_eq "$(jq -r .healthy_digest "$STATE_FILE")" "$OLD"
)
ok "same digest is a silent no-op"

(
  setup_orchestrator
  discover_digest() { printf '%s\n' "$NEW"; }
  run_update
  assert_eq "$(cat "$MUTATIONS")" "$NEW"
  assert_eq "$(jq -r .healthy_digest "$STATE_FILE")" "$NEW"
  assert_eq "$(jq -r .previous_digest "$STATE_FILE")" "$OLD"
)
ok "successful update records immutable current and previous digests"

(
  setup_orchestrator
  discover_digest() { printf '%s\n' "$NEW"; }
  wait_healthy() { [[ "$1" == "$OLD" ]]; }
  if run_update; then fail failed-update-returned-success; fi
  assert_eq "$(paste -sd, "$MUTATIONS")" "$NEW,$OLD"
  assert_eq "$(jq -r .healthy_digest "$STATE_FILE")" "$OLD"
  jq -e --arg digest "$NEW" '.failed_digests == [$digest] and (.recovery_required != true)' "$STATE_FILE" >/dev/null
)
ok "failed update attempts exactly one rollback and quarantines digest"

(
  setup_orchestrator
  discover_digest() { printf '%s\n' "$NEW"; }
  image_metadata() { jq -n --arg digest "$1" '{digest:$digest,revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",version:"0.4.2",schema:"2"}'; }
  if run_update; then fail schema-change-returned-success; fi
  [[ ! -s "$MUTATIONS" ]] || fail schema-change-mutated
)
ok "SQLite schema mismatch blocks before Compose mutation"

baseline_preserved "$BASELINE" '{"integrity":"ok","schema":"1","counts":{"users":1,"monitors":2,"captures":4,"events":5,"channels":1}}' \
  || fail continuity-increase
if baseline_preserved "$BASELINE" '{"integrity":"ok","schema":"1","counts":{"users":1,"monitors":1,"captures":3,"events":4,"channels":1}}'; then
  fail continuity-decrease
fi
ok "SQLite continuity rejects decreased durable record counts"

(
  FUSION_IMAGE_REF=
  CAPTURE="$(mktemp)"
  compose() { printf '%s\n' "$*" >"$CAPTURE"; }
  apply_digest "$NEW"
  assert_eq "$(cat "$CAPTURE")" "up -d --no-build --no-deps fusion"
  if apply_digest latest; then fail mutable-tag-accepted; fi
)
ok "deployment is digest-only, no-build and fusion-service scoped"

(
  FUSION_PROJECT_NAME=changd-fusion-simple
  FUSION_HEALTH_URL=http://127.0.0.1:8127/api/v1/health
  contract='{
    "format":1,"project":"changd-fusion-simple","service":"fusion",
    "data_mount":[{"type":"volume","source":"changd-fusion-simple_simple-data","destination":"/data","rw":true}],
    "ports":[{"container":"3000/tcp","bindings":[{"host_ip":"127.0.0.1","host_port":"8127"}]}],
    "networks":["changd-fusion-simple_default"],"environment":[],
    "security_opt":["seccomp=/opt/changd-fusion/docker/chromium-seccomp.json"],
    "memory":1677721600,"pids_limit":256,"shm_size":268435456,"restart":"unless-stopped"
  }'
  validate_contract_shape <<<"$contract"
  if validate_contract_shape <<<"$(jq '.ports[0].bindings[0].host_ip="0.0.0.0"' <<<"$contract")"; then fail public-bind-accepted; fi
  if validate_contract_shape <<<"$(jq '.data_mount[0].destination="/tmp"' <<<"$contract")"; then fail wrong-volume-accepted; fi
)
ok "runtime contract pins loopback port, /data volume and positive resource limits"

(
  REMOVED="$(mktemp)"
  USED="sha256:$(printf '4%.0s' {1..64})"
  UNUSED="sha256:$(printf '5%.0s' {1..64})"
  docker() {
    if [[ "$*" == "image ls $IMAGE_REPOSITORY --digests --no-trunc --format {{.Digest}} {{.ID}}" ]]; then
      printf '%s id-used\n%s id-unused\n' "$USED" "$UNUSED"
    elif [[ "$*" == "ps -aq" ]]; then
      printf 'unrelated-container\n'
    elif [[ "$*" == "inspect --format {{.Image}} unrelated-container" ]]; then
      printf 'id-used\n'
    elif [[ "$1 $2" == "image rm" ]]; then
      printf '%s\n' "$3" >>"$REMOVED"
    else
      fail "unexpected docker call: $*"
    fi
  }
  cleanup_old_images "$NEW" "$OLD"
  assert_eq "$(cat "$REMOVED")" "$IMAGE_REPOSITORY@$UNUSED"
)
ok "cleanup preserves images used by unrelated containers"

grep -q "if: github.event_name == 'push' && github.ref == 'refs/heads/master'" "$ROOT/.github/workflows/simple-ci.yml"
grep -q 'needs: \[sqlite-and-code, container-build\]' "$ROOT/.github/workflows/simple-ci.yml"
grep -q 'push: true' "$ROOT/.github/workflows/simple-ci.yml"
ok "image publication requires successful master CI jobs"

printf '1..%d\n' "$PASS"
