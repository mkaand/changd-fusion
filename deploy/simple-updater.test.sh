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
BASELINE='{"integrity":"ok","schema":"1"}'

(
  FUSION_STATE_DIR="$(mktemp -d)"
  STATE_FILE="$FUSION_STATE_DIR/state.json"
  jq -n --arg digest "$OLD" --argjson baseline "$BASELINE" \
    '{format:1,healthy_digest:$digest,previous_digest:null,version:"0.4.1",failed_digests:[],baseline:$baseline}' >"$STATE_FILE"
  load_state
  assert_eq "$(jq -r type <<<"$STATE")" object
  assert_eq "$(jq -r .healthy_digest <<<"$STATE")" "$OLD"
  printf 'true\n' >"$STATE_FILE"
  if load_state >/dev/null 2>&1; then fail boolean-state-accepted; fi
  jq -n --arg digest "$OLD" --argjson baseline "$BASELINE" \
    '{format:1,healthy_digest:$digest,previous_digest:null,version:"0.4.1",failed_digests:["latest"],baseline:$baseline}' >"$STATE_FILE"
  if load_state >/dev/null 2>&1; then fail malformed-failed-digest-accepted; fi
)
ok "load_state returns the validated JSON object and rejects booleans"

(
  container_id() { printf 'fixture-container\n'; }
  docker() {
    [[ "$1" == exec ]] || fail "unexpected docker call: $*"
    printf '{"integrity":"ok","schema":"1"}\n'
  }
  result="$(sqlite_baseline)"
  assert_eq "$(jq -r type <<<"$result")" object
  assert_eq "$(jq -r '.integrity + ":" + .schema' <<<"$result")" "ok:1"
  docker() { printf '{"integrity":"corrupt","schema":"1"}\n'; }
  if sqlite_baseline >/dev/null 2>&1; then fail corrupt-sqlite-accepted; fi
)
ok "sqlite_baseline returns a validated JSON object and fails closed"

(
  docker() {
    jq -n --arg digest "$NEW" '[{
      RepoDigests:["ghcr.io/mkaand/changd-fusion@"+$digest],Os:"linux",Architecture:"amd64",
      Config:{Labels:{
        "org.opencontainers.image.source":"https://github.com/mkaand/changd-fusion",
        "org.opencontainers.image.revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "org.opencontainers.image.version":"0.4.2",
        "io.changd-fusion.sqlite-schema":"1"
      }}
    }]'
  }
  result="$(image_metadata "$NEW")"
  assert_eq "$(jq -r type <<<"$result")" object
  assert_eq "$(jq -r '.digest + ":" + .schema' <<<"$result")" "$NEW:1"
  docker() { printf '[]\n'; }
  if image_metadata "$NEW" >/dev/null 2>&1; then fail malformed-image-accepted; fi
)
ok "image_metadata returns verified metadata and rejects malformed inspection"

setup_orchestrator() {
  TEST_DIR="$(mktemp -d)"
  FUSION_STATE_DIR="$TEST_DIR"
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
  current_digest() { printf '%s\n' "$OLD"; }
  docker() { [[ "$1" == pull ]]; }
  image_metadata() { jq -n --arg digest "$1" '{digest:$digest,revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",version:"0.4.2",schema:"1"}'; }
  trusted_master_sha() { printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'; }
  sqlite_baseline() { printf '%s\n' "$BASELINE"; }
  apply_digest() { printf '%s\n' "$1" >>"$MUTATIONS"; }
  wait_healthy() { :; }
  cleanup_old_images() { :; }
  CLEANED="$TEST_DIR/cleaned"
  : >"$CLEANED"
  remove_unused_digest() { printf '%s\n' "$1" >>"$CLEANED"; }
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
  assert_eq "$(cat "$CLEANED")" "$NEW"
)
ok "failed update rolls back, quarantines and cleans the unused candidate"

(
  setup_orchestrator
  jq '.recovery_required=true' "$STATE_FILE" >"$STATE_FILE.next"
  mv "$STATE_FILE.next" "$STATE_FILE"
  discover_digest() { fail discovery-ran-during-recovery; }
  if run_update; then fail recovery-lock-returned-success; fi
  [[ ! -s "$MUTATIONS" ]] || fail recovery-lock-mutated
)
ok "recovery_required blocks every automatic deployment before discovery"

(
  setup_orchestrator
  jq '.recovery_required=true' "$STATE_FILE" >"$STATE_FILE.next"
  mv "$STATE_FILE.next" "$STATE_FILE"
  image_metadata() { jq -n --arg digest "$1" '{digest:$digest,revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",version:"0.4.1",schema:"1"}'; }
  recover_state
  jq -e --arg digest "$OLD" '.healthy_digest==$digest and (.recovery_required != true) and .recovered_at' "$STATE_FILE" >/dev/null
)
ok "manual recover-state validates runtime, image, health and SQLite before unlock"

(
  setup_orchestrator
  discover_digest() { printf '%s\n' "$NEW"; }
  image_metadata() { jq -n --arg digest "$1" '{digest:$digest,revision:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",version:"0.4.2",schema:"2"}'; }
  if run_update; then fail schema-change-returned-success; fi
  [[ ! -s "$MUTATIONS" ]] || fail schema-change-mutated
  assert_eq "$(cat "$CLEANED")" "$NEW"
)
ok "SQLite schema mismatch blocks before mutation and removes the unused pull"

sqlite_compatible \
  '{"integrity":"ok","schema":"1","counts":{"users":10,"monitors":20,"captures":30,"events":40,"channels":5}}' \
  '{"integrity":"ok","schema":"1","counts":{"users":1,"monitors":0,"captures":2,"events":3,"channels":0}}' \
  || fail natural-record-count-change-rejected
if sqlite_compatible "$BASELINE" '{"integrity":"ok","schema":"2"}'; then fail schema-change-accepted; fi
! grep -Eq 'SELECT count|\.counts|baseline_preserved' "$ROOT/deploy/simple-updater.sh" || fail record-count-gate-present
ok "deployment acceptance ignores record counts while preserving integrity and schema gates"

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

(
  REMOVED="$(mktemp)"
  docker() {
    if [[ "$*" == "image inspect --format {{.Id}} $IMAGE_REPOSITORY@$NEW" ]]; then
      printf 'id-candidate\n'
    elif [[ "$*" == "ps -aq" ]]; then
      printf 'unrelated-container\n'
    elif [[ "$*" == "inspect --format {{.Image}} unrelated-container" ]]; then
      printf 'id-unrelated\n'
    elif [[ "$1 $2" == "image rm" ]]; then
      printf '%s\n' "$3" >>"$REMOVED"
    else
      fail "unexpected docker call: $*"
    fi
  }
  remove_unused_digest "$NEW" "$OLD" "$BAD"
  assert_eq "$(cat "$REMOVED")" "$IMAGE_REPOSITORY@$NEW"
  : >"$REMOVED"
  docker() {
    if [[ "$*" == "image inspect --format {{.Id}} $IMAGE_REPOSITORY@$NEW" ]]; then
      printf 'id-candidate\n'
    elif [[ "$*" == "ps -aq" ]]; then
      printf 'candidate-container\n'
    elif [[ "$*" == "inspect --format {{.Image}} candidate-container" ]]; then
      printf 'id-candidate\n'
    elif [[ "$1 $2" == "image rm" ]]; then
      fail running-candidate-removed
    else
      fail "unexpected docker call: $*"
    fi
  }
  remove_unused_digest "$NEW" "$OLD" "$BAD"
  [[ ! -s "$REMOVED" ]] || fail running-candidate-removed
  docker() { fail protected-digest-inspected; }
  remove_unused_digest "$OLD" "$OLD" "$BAD"
  remove_unused_digest "$BAD" "$OLD" "$BAD"
)
ok "failed candidate cleanup is exact and preserves protected/running images"

grep -q "if: github.event_name == 'push' && github.ref == 'refs/heads/master'" "$ROOT/.github/workflows/simple-ci.yml"
grep -q 'needs: \[sqlite-and-code, container-build\]' "$ROOT/.github/workflows/simple-ci.yml"
grep -q 'push: true' "$ROOT/.github/workflows/simple-ci.yml"
grep -q 'SCHEMA_VERSION' "$ROOT/.github/workflows/simple-ci.yml"
grep -q 'io.changd-fusion.sqlite-schema=\${{ env.SQLITE_SCHEMA_VERSION }}' "$ROOT/.github/workflows/simple-ci.yml"
! grep -q 'io.changd-fusion.sqlite-schema=1' "$ROOT/.github/workflows/simple-ci.yml"
expected_schema="$(node -e 'import("./simple/db.mjs").then(({SCHEMA_VERSION})=>console.log(SCHEMA_VERSION))')"
[[ "$expected_schema" =~ ^[0-9]+$ ]]
ok "image publication requires successful master CI and derives the real schema version"

printf '1..%d\n' "$PASS"
