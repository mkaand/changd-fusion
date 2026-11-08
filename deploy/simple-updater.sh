#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly IMAGE_REPOSITORY="ghcr.io/mkaand/changd-fusion"
readonly SOURCE_REPOSITORY="https://github.com/mkaand/changd-fusion"
readonly EXPECTED_PROJECT_NAME="changd-fusion"
readonly EXPECTED_CONTAINER_NAME="changd-fusion"
readonly EXPECTED_DATA_VOLUME="changd-fusion-data"
readonly EXPECTED_NETWORK="changd-fusion_default"
readonly GITHUB_COMMIT_API="https://api.github.com/repos/mkaand/changd-fusion/commits/master"
readonly REGISTRY_TOKEN_URL="https://ghcr.io/token?service=ghcr.io&scope=repository%3Amkaand%2Fchangd-fusion%3Apull"
readonly REGISTRY_MANIFEST_URL="https://ghcr.io/v2/mkaand/changd-fusion/manifests/master"
readonly DIGEST_PATTERN='^sha256:[0-9a-f]{64}$'
readonly SHA_PATTERN='^[0-9a-f]{40}$'

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "BLOCKED: $*"; return 1; }

require_commands() {
  local command
  for command in docker curl jq flock df sort mktemp; do
    command -v "$command" >/dev/null || die "missing_command:$command" || return
  done
  docker compose version >/dev/null 2>&1 || die "docker_compose_v2_unavailable"
}

validate_config() {
  : "${FUSION_PROJECT_NAME:?FUSION_PROJECT_NAME is required}"
  : "${FUSION_PROJECT_DIR:?FUSION_PROJECT_DIR is required}"
  : "${FUSION_COMPOSE_FILES:?FUSION_COMPOSE_FILES is required}"
  : "${FUSION_CONTRACT_FILE:?FUSION_CONTRACT_FILE is required}"
  : "${FUSION_STATE_DIR:?FUSION_STATE_DIR is required}"
  : "${FUSION_HEALTH_URL:?FUSION_HEALTH_URL is required}"
  [[ "$FUSION_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{1,62}$ ]] || die "invalid_project_name" || return
  [[ "$FUSION_PROJECT_NAME" == "$EXPECTED_PROJECT_NAME" ]] || die "unexpected_project_name" || return
  [[ "$FUSION_PROJECT_DIR" = /* && -d "$FUSION_PROJECT_DIR" ]] || die "invalid_project_directory" || return
  [[ "$FUSION_CONTRACT_FILE" = /* && "$FUSION_STATE_DIR" = /* ]] || die "state_paths_must_be_absolute" || return
  [[ "$FUSION_HEALTH_URL" =~ ^http://127\.0\.0\.1:([1-9][0-9]{0,4})/api/v1/health$ ]] || die "invalid_health_url" || return
  local health_port="${BASH_REMATCH[1]}"
  (( health_port <= 65535 )) || die "invalid_health_port" || return
  FUSION_MIN_FREE_MB="${FUSION_MIN_FREE_MB:-2048}"
  [[ "$FUSION_MIN_FREE_MB" =~ ^[1-9][0-9]*$ ]] || die "invalid_minimum_disk_space" || return
  IFS=: read -r -a COMPOSE_FILES <<<"$FUSION_COMPOSE_FILES"
  (( ${#COMPOSE_FILES[@]} >= 2 )) || die "base_and_ghcr_compose_files_required" || return
  local file
  for file in "${COMPOSE_FILES[@]}"; do
    [[ "$file" = /* && -f "$file" && -r "$file" ]] || die "invalid_compose_file" || return
  done
  [[ "${COMPOSE_FILES[-1]}" == *docker-compose.ghcr.yml ]] || die "ghcr_override_must_be_last" || return
}

compose() {
  local args=(compose --project-name "$FUSION_PROJECT_NAME" --project-directory "$FUSION_PROJECT_DIR") file
  for file in "${COMPOSE_FILES[@]}"; do args+=(-f "$file"); done
  docker "${args[@]}" "$@"
}

atomic_write() {
  local destination="$1" mode="${2:-600}" directory temporary
  directory="$(dirname "$destination")"
  mkdir -p -m 700 "$directory"
  temporary="$(mktemp "$directory/.tmp.XXXXXX")"
  cat >"$temporary"
  chmod "$mode" "$temporary"
  sync -f "$temporary" 2>/dev/null || sync "$temporary"
  mv -f "$temporary" "$destination"
  sync -d "$directory" 2>/dev/null || true
}

container_id() {
  local ids
  ids="$(FUSION_IMAGE_REF="${1:-$IMAGE_REPOSITORY:master}" compose ps -aq fusion)"
  [[ -n "$ids" && "$(wc -l <<<"$ids")" -eq 1 ]] || die "fusion_container_missing_or_ambiguous" || return
  printf '%s\n' "$ids"
}

compose_preflight() {
  local services
  services="$(FUSION_IMAGE_REF="$IMAGE_REPOSITORY:master" compose config --services)"
  [[ "$services" == "fusion" ]] || die "unexpected_compose_services" || return
  FUSION_IMAGE_REF="$IMAGE_REPOSITORY:master" compose config --format json \
    | jq -e --arg project "$EXPECTED_PROJECT_NAME" --arg container "$EXPECTED_CONTAINER_NAME" \
      --arg volume "$EXPECTED_DATA_VOLUME" --arg network "$EXPECTED_NETWORK" '
      .name == $project and
      (.services | keys) == ["fusion"] and
      .services.fusion.container_name == $container and
      (.services.fusion.volumes | length) == 1 and
      (.services.fusion.volumes[0].target == "/data" and .services.fusion.volumes[0].type == "volume") and
      .volumes[.services.fusion.volumes[0].source].name == $volume and
      (.services.fusion.networks | keys) == ["default"] and
      .networks.default.name == $network and
      (.services.fusion.ports | length) == 1 and
      (.services.fusion.ports[0].host_ip == "127.0.0.1") and
      (.services.fusion.ports[0].target == 3000) and
      (.services.fusion.ports[0].protocol == "tcp")
    ' >/dev/null || die "unsafe_compose_contract"
}

runtime_contract() {
  local id inspect compose_json
  id="$(container_id)" || return
  inspect="$(docker inspect "$id")" || return
  compose_json="$(FUSION_IMAGE_REF="$IMAGE_REPOSITORY:master" compose config --format json)" || return
  jq -n -S --argjson inspect "$inspect" --argjson compose "$compose_json" '
    ($inspect[0]) as $i |
    ($compose.services.fusion.environment // {}) as $declared_env |
    ($i.Config.Env | map(split("=") | {(.[0]): (.[1:] | join("="))}) | add) as $actual_env |
    {
      format: 1,
      project: $i.Config.Labels["com.docker.compose.project"],
      service: $i.Config.Labels["com.docker.compose.service"],
      container_name: ($i.Name | ltrimstr("/")),
      data_mount: ($i.Mounts | map(select(.Destination == "/data") | {type:.Type,source:.Name,destination:.Destination,rw:.RW})),
      ports: ($i.NetworkSettings.Ports | to_entries | map({container:.key,bindings:(.value // [] | map({host_ip:.HostIp,host_port:.HostPort}))})),
      networks: ($i.NetworkSettings.Networks | keys | sort),
      environment: ($declared_env | keys | sort | map({key:.,value:$actual_env[.]})),
      security_opt: ($i.HostConfig.SecurityOpt // [] | sort),
      memory: $i.HostConfig.Memory,
      pids_limit: $i.HostConfig.PidsLimit,
      shm_size: $i.HostConfig.ShmSize,
      restart: $i.HostConfig.RestartPolicy.Name
    }
  '
}

validate_contract_shape() {
  jq -e --arg project "$EXPECTED_PROJECT_NAME" --arg container "$EXPECTED_CONTAINER_NAME" \
    --arg volume "$EXPECTED_DATA_VOLUME" --arg network "$EXPECTED_NETWORK" --arg health "$FUSION_HEALTH_URL" '
    .format == 1 and .project == $project and .service == "fusion" and .container_name == $container and
    (.data_mount | length) == 1 and .data_mount[0].type == "volume" and
    .data_mount[0].source == $volume and .data_mount[0].destination == "/data" and .data_mount[0].rw == true and
    (.ports | length) == 1 and .ports[0].container == "3000/tcp" and
    (.ports[0].bindings | length) == 1 and .ports[0].bindings[0].host_ip == "127.0.0.1" and
    ($health == ("http://127.0.0.1:" + .ports[0].bindings[0].host_port + "/api/v1/health")) and
    .networks == [$network] and
    (.security_opt | any(startswith("seccomp="))) and
    .pids_limit > 0 and .memory > 0 and .shm_size > 0 and
    .restart == "unless-stopped"
  ' >/dev/null
}

snapshot_contract() {
  compose_preflight || return
  local contract
  contract="$(runtime_contract)" || return
  validate_contract_shape <<<"$contract" || die "unsafe_runtime_contract" || return
  atomic_write "$FUSION_CONTRACT_FILE" 600 <<<"$contract"
  log "Runtime contract recorded; review it before enabling the timer."
}

verify_contract() {
  [[ -f "$FUSION_CONTRACT_FILE" ]] || die "runtime_contract_missing" || return
  local expected actual
  expected="$(jq -cS . "$FUSION_CONTRACT_FILE")" || die "runtime_contract_invalid" || return
  actual="$(runtime_contract | jq -cS .)" || return
  validate_contract_shape <<<"$actual" || die "unsafe_runtime_contract" || return
  [[ "$expected" == "$actual" ]] || die "runtime_contract_mismatch"
}

target_compose_contract() {
  local digest="$1" compose_json
  [[ "$digest" =~ $DIGEST_PATTERN ]] || die "invalid_target_digest" || return
  compose_json="$(FUSION_IMAGE_REF="$IMAGE_REPOSITORY@$digest" compose config --format json)" || return
  jq -n -S --argjson compose "$compose_json" --arg project_dir "$FUSION_PROJECT_DIR" \
    --arg image "$IMAGE_REPOSITORY@$digest" '
    ($compose.services.fusion) as $service |
    if ($service.image != $image) then error("target_image_mismatch") else
      {
        format: 1,
        project: $compose.name,
        service: "fusion",
        container_name: $service.container_name,
        data_mount: ($service.volumes | map(select(.target == "/data") | {
          type:.type,source:$compose.volumes[.source].name,destination:.target,rw:(.read_only != true)
        })),
        ports: ($service.ports | map({
          container:((.target|tostring) + "/" + .protocol),
          bindings:[{host_ip:.host_ip,host_port:.published}]
        })),
        networks: ($service.networks | keys | map($compose.networks[.].name) | sort),
        environment: (($service.environment // {}) | to_entries | sort_by(.key)),
        security_opt: (($service.security_opt // []) | map(
          if startswith("seccomp=./") then "seccomp=" + $project_dir + "/" + ltrimstr("seccomp=./") else . end
        ) | sort),
        memory: ($service.mem_limit | tonumber),
        pids_limit: $service.pids_limit,
        shm_size: ($service.shm_size | tonumber),
        restart: $service.restart
      }
    end
  '
}

verify_target_contract() {
  local digest="$1" expected target
  [[ -f "$FUSION_CONTRACT_FILE" ]] || die "runtime_contract_missing" || return
  expected="$(jq -cS . "$FUSION_CONTRACT_FILE")" || die "runtime_contract_invalid" || return
  target="$(target_compose_contract "$digest" | jq -cS .)" || return
  validate_contract_shape <<<"$target" || die "unsafe_target_compose_contract" || return
  [[ "$expected" == "$target" ]] || die "target_compose_contract_mismatch"
}

sqlite_baseline() {
  local id
  id="$(container_id)" || return
  docker exec "$id" node -e '
    const {DatabaseSync}=require("node:sqlite");
    const db=new DatabaseSync("/data/fusion.sqlite",{readOnly:true});
    const scalar=(sql)=>db.prepare(sql).get();
    const integrity=scalar("PRAGMA integrity_check").integrity_check;
    const schema=db.prepare("SELECT value FROM metadata WHERE key=?").get("schema_version")?.value;
    console.log(JSON.stringify({integrity,schema}));db.close();
  ' | jq -ce 'if (.integrity == "ok" and (.schema | test("^[0-9]+$"))) then . else error("invalid_sqlite_state") end'
}

sqlite_compatible() {
  local before="$1" after="$2"
  jq -en --argjson before "$before" --argjson after "$after" '
    $before.integrity == "ok" and $after.integrity == "ok" and
    ($before.schema | test("^[0-9]+$")) and $after.schema == $before.schema
  ' >/dev/null
}

wait_healthy() {
  local expected_digest="$1" id status body attempt
  for attempt in $(seq 1 30); do
    id="$(container_id 2>/dev/null || true)"
    if [[ -n "$id" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || true)"
      if [[ "$status" == healthy ]]; then
        body="$(curl --fail --silent --show-error --max-time 5 "$FUSION_HEALTH_URL" 2>/dev/null || true)"
        if jq -e '.status == "ok" and .store == "sqlite"' <<<"$body" >/dev/null 2>&1 \
           && current_digest | grep -qx "$expected_digest"; then
          return 0
        fi
      fi
    fi
    sleep 2
  done
  return 1
}

current_digest() {
  local id image_id
  id="$(container_id)" || return
  image_id="$(docker inspect --format '{{.Image}}' "$id")" || return
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" \
    | sed -n "s#^${IMAGE_REPOSITORY}@##p" | sort -u
}

image_metadata() {
  local digest="$1"
  [[ "$digest" =~ $DIGEST_PATTERN ]] || die "invalid_image_digest" || return
  docker image inspect "$IMAGE_REPOSITORY@$digest" | jq -ce --arg digest "$digest" --arg source "$SOURCE_REPOSITORY" '
    .[0] as $i |
    if (
      ($i.RepoDigests | any(. == ("ghcr.io/mkaand/changd-fusion@" + $digest))) and
      $i.Os == "linux" and $i.Architecture == "amd64" and
      $i.Config.Labels["org.opencontainers.image.source"] == $source and
      ($i.Config.Labels["org.opencontainers.image.revision"] | test("^[0-9a-f]{40}$")) and
      ($i.Config.Labels["org.opencontainers.image.version"] | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
      ($i.Config.Labels["io.changd-fusion.sqlite-schema"] | test("^[0-9]+$"))
    ) then
      {digest:$digest,revision:$i.Config.Labels["org.opencontainers.image.revision"],version:$i.Config.Labels["org.opencontainers.image.version"],schema:$i.Config.Labels["io.changd-fusion.sqlite-schema"]}
    else error("invalid_image_metadata") end
  '
}

discover_digest() {
  local token headers body digest
  token="$(curl --fail --silent --show-error --max-time 20 "$REGISTRY_TOKEN_URL" | jq -er '.token')" \
    || die "anonymous_ghcr_access_unavailable" || return
  headers="$(mktemp)"; body="$(mktemp)"
  if ! curl --fail --silent --show-error --max-time 30 --max-redirs 0 \
      -H "Authorization: Bearer $token" \
      -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
      -D "$headers" -o "$body" "$REGISTRY_MANIFEST_URL"; then
    rm -f "$headers" "$body"; unset token
    die "anonymous_ghcr_manifest_unavailable"; return
  fi
  digest="$(parse_digest_header "$headers")" || {
    rm -f "$headers" "$body"; unset token
    die "registry_digest_missing"; return
  }
  rm -f "$headers" "$body"; unset token
  printf '%s\n' "$digest"
}

parse_digest_header() {
  local headers="$1" values
  [[ -f "$headers" ]] || return 1
  values="$(awk '
    {
      sub(/\r$/, "", $0)
      name=$0
      sub(/:.*/, "", name)
      if (tolower(name) == "docker-content-digest") {
        value=$0
        sub(/^[^:]*:[[:space:]]*/, "", value)
        print value
      }
    }
  ' "$headers")"
  [[ -n "$values" && "$(wc -l <<<"$values")" -eq 1 && "$values" =~ $DIGEST_PATTERN ]] || return 1
  printf '%s\n' "$values"
}

trusted_master_sha() {
  local sha
  sha="$(curl --fail --silent --show-error --max-time 20 \
    -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
    "$GITHUB_COMMIT_API" | jq -er '.sha')" || die "github_master_unavailable" || return
  [[ "$sha" =~ $SHA_PATTERN ]] || die "invalid_github_master_sha" || return
  printf '%s\n' "$sha"
}

check_disk() {
  local available
  available="$(df -Pk "$FUSION_PROJECT_DIR" | awk 'NR==2 {print int($4/1024)}')"
  (( available >= FUSION_MIN_FREE_MB )) || die "insufficient_disk_space"
}

load_state() {
  STATE_FILE="$FUSION_STATE_DIR/state.json"
  [[ -f "$STATE_FILE" ]] || die "bootstrap_required" || return
  STATE="$(jq -ce '
    if (
      .format == 1 and (.healthy_digest | test("^sha256:[0-9a-f]{64}$")) and
      (.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
      (.failed_digests | type == "array") and
      all(.failed_digests[]; test("^sha256:[0-9a-f]{64}$")) and
      (.previous_digest == null or (.previous_digest | test("^sha256:[0-9a-f]{64}$"))) and
      (.baseline | type == "object") and .baseline.integrity == "ok" and
      (.baseline.schema | test("^[0-9]+$")) and
      ((.recovery_required // false) | type == "boolean")
    ) then . else error("invalid_updater_state") end
  ' "$STATE_FILE")" || die "invalid_updater_state"
}

assert_state_deployable() {
  jq -e '(.recovery_required // false) == false' <<<"$STATE" >/dev/null \
    || die "recovery_required_manual_validation_required"
}

write_state() { atomic_write "$STATE_FILE" 600 <<<"$1"; }

bootstrap_state() {
  verify_contract || return
  local digest metadata baseline state
  digest="$(current_digest)" || return
  [[ "$digest" =~ $DIGEST_PATTERN ]] || die "current_image_is_not_immutable_ghcr_digest" || return
  metadata="$(image_metadata "$digest")" || return
  baseline="$(sqlite_baseline)" || return
  wait_healthy "$digest" || die "current_deployment_unhealthy" || return
  STATE_FILE="$FUSION_STATE_DIR/state.json"
  state="$(jq -n --arg digest "$digest" --arg version "$(jq -r .version <<<"$metadata")" --argjson baseline "$baseline" \
    '{format:1,healthy_digest:$digest,previous_digest:null,version:$version,failed_digests:[],baseline:$baseline,updated_at:(now|todateiso8601)}')"
  write_state "$state"
  log "Initial immutable deployment state recorded; the timer remains disabled."
}

recover_state() {
  verify_contract || return
  load_state || return
  jq -e '.recovery_required == true' <<<"$STATE" >/dev/null \
    || die "recovery_state_not_set" || return
  local digest metadata sqlite previous state
  digest="$(current_digest)" || return
  [[ "$digest" =~ $DIGEST_PATTERN ]] || die "current_image_is_not_immutable_ghcr_digest" || return
  metadata="$(image_metadata "$digest")" || return
  sqlite="$(sqlite_baseline)" || return
  [[ "$(jq -r .schema <<<"$metadata")" == "$(jq -r .schema <<<"$sqlite")" ]] \
    || die "recovered_image_schema_mismatch" || return
  wait_healthy "$digest" || die "recovered_deployment_unhealthy" || return
  previous="$(jq -c --arg digest "$digest" 'if .healthy_digest == $digest then .previous_digest else .healthy_digest end' <<<"$STATE")"
  state="$(jq --arg digest "$digest" --arg version "$(jq -r .version <<<"$metadata")" \
    --argjson sqlite "$sqlite" --argjson previous "$previous" '
      .healthy_digest=$digest | .previous_digest=$previous |
      .version=$version | .baseline=$sqlite | del(.recovery_required) |
      .recovered_at=(now|todateiso8601) | .updated_at=(now|todateiso8601)
    ' <<<"$STATE")"
  write_state "$state"
  log "Recovery state validated and cleared; review before restarting the timer."
}

apply_digest() {
  local digest="$1"
  [[ "$digest" =~ $DIGEST_PATTERN ]] || die "invalid_apply_digest" || return
  FUSION_IMAGE_REF="$IMAGE_REPOSITORY@$digest" compose up -d --no-build --no-deps fusion
}

notify() {
  local kind="$1" message="$2"
  if [[ -z "${FUSION_TELEGRAM_BOT_TOKEN:-}" && -z "${FUSION_TELEGRAM_CHAT_ID:-}" ]]; then return 0; fi
  if [[ -z "${FUSION_TELEGRAM_BOT_TOKEN:-}" || -z "${FUSION_TELEGRAM_CHAT_ID:-}" ]]; then
    log "Telegram notification skipped: incomplete configuration"; return 0
  fi
  if [[ ! "$FUSION_TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] \
     || [[ ! "$FUSION_TELEGRAM_CHAT_ID" =~ ^-?[0-9]+$ ]]; then
    log "Telegram notification skipped: invalid configuration"; return 0
  fi
  local result=0
  curl --fail --silent --show-error --max-time 10 \
    --data-urlencode "chat_id=$FUSION_TELEGRAM_CHAT_ID" \
    --data-urlencode "text=Changd Fusion $kind: $message" \
    --config - >/dev/null <<EOF || result=$?
url = "https://api.telegram.org/bot${FUSION_TELEGRAM_BOT_TOKEN}/sendMessage"
EOF
  (( result == 0 )) || log "Telegram notification delivery failed"
}

cleanup_old_images() {
  local keep_current="$1" keep_previous="$2" digest image_id used
  while read -r digest image_id; do
    [[ "$digest" =~ $DIGEST_PATTERN ]] || continue
    [[ "$digest" == "$keep_current" || "$digest" == "$keep_previous" ]] && continue
    used=0
    while read -r container; do
      [[ -z "$container" ]] && continue
      [[ "$(docker inspect --format '{{.Image}}' "$container")" == "$image_id" ]] && used=1
    done < <(docker ps -aq)
    (( used == 1 )) && continue
    docker image rm "$IMAGE_REPOSITORY@$digest" >/dev/null || log "Old image cleanup skipped for $digest"
  done < <(docker image ls "$IMAGE_REPOSITORY" --digests --no-trunc --format '{{.Digest}} {{.ID}}')
}

remove_unused_digest() {
  local digest="$1" protect_current="$2" protect_rollback="$3" image_id container
  [[ "$digest" =~ $DIGEST_PATTERN ]] || return 1
  [[ "$digest" == "$protect_current" || "$digest" == "$protect_rollback" ]] && return 0
  image_id="$(docker image inspect --format '{{.Id}}' "$IMAGE_REPOSITORY@$digest" 2>/dev/null || true)"
  [[ -n "$image_id" ]] || return 0
  while read -r container; do
    [[ -z "$container" ]] && continue
    if [[ "$(docker inspect --format '{{.Image}}' "$container")" == "$image_id" ]]; then return 0; fi
  done < <(docker ps -aq)
  docker image rm "$IMAGE_REPOSITORY@$digest" >/dev/null \
    || log "Failed candidate image cleanup skipped for $digest"
}

version_is_older() {
  local candidate="$1" current="$2"
  [[ "$candidate" != "$current" && "$(printf '%s\n%s\n' "$candidate" "$current" | sort -V | head -1)" == "$candidate" ]]
}

run_update() {
  compose_preflight || return
  verify_contract || return
  check_disk || return
  load_state || return
  assert_state_deployable || return
  local candidate current previous rollback_target before metadata master candidate_version candidate_schema current_schema after new_state rollback_ok=0
  candidate="$(discover_digest)" || return
  current="$(jq -r .healthy_digest <<<"$STATE")"
  [[ "$(current_digest)" == "$current" ]] || die "recorded_and_running_digest_mismatch" || return
  if [[ "$candidate" == "$current" ]]; then return 0; fi
  jq -e --arg digest "$candidate" '.failed_digests | index($digest) == null' <<<"$STATE" >/dev/null \
    || die "candidate_previously_failed" || return
  check_disk || return
  docker pull "$IMAGE_REPOSITORY@$candidate" >/dev/null || die "immutable_image_pull_failed" || return
  rollback_target="$(jq -r '.previous_digest // ""' <<<"$STATE")"
  metadata="$(image_metadata "$candidate")" \
    || { remove_unused_digest "$candidate" "$current" "$rollback_target"; return 1; }
  master="$(trusted_master_sha)" \
    || { remove_unused_digest "$candidate" "$current" "$rollback_target"; return 1; }
  if [[ "$(jq -r .revision <<<"$metadata")" != "$master" ]]; then
    remove_unused_digest "$candidate" "$current" "$rollback_target"
    die "image_revision_is_not_current_master"
    return 1
  fi
  candidate_version="$(jq -r .version <<<"$metadata")"
  if version_is_older "$candidate_version" "$(jq -r .version <<<"$STATE")"; then
    remove_unused_digest "$candidate" "$current" "$rollback_target"
    die "version_downgrade_rejected"
    return 1
  fi
  before="$(sqlite_baseline)" \
    || { remove_unused_digest "$candidate" "$current" "$rollback_target"; return 1; }
  current_schema="$(jq -r .schema <<<"$before")"
  candidate_schema="$(jq -r .schema <<<"$metadata")"
  if [[ "$candidate_schema" != "$current_schema" ]]; then
    remove_unused_digest "$candidate" "$current" "$rollback_target"
    die "sqlite_schema_change_requires_manual_upgrade"
    return 1
  fi
  if ! verify_target_contract "$candidate"; then
    remove_unused_digest "$candidate" "$current" "$rollback_target"
    return 1
  fi
  previous="$current"
  if apply_digest "$candidate" && wait_healthy "$candidate" && verify_contract; then
    after="$(sqlite_baseline)" || true
    if [[ -n "$after" ]] && sqlite_compatible "$before" "$after"; then
      new_state="$(jq --arg digest "$candidate" --arg previous "$previous" --arg version "$candidate_version" --argjson baseline "$after" \
        '.previous_digest=$previous | .healthy_digest=$digest | .version=$version | .baseline=$baseline | .updated_at=(now|todateiso8601)' <<<"$STATE")"
      write_state "$new_state"
      cleanup_old_images "$candidate" "$previous"
      notify SUCCESS "version $candidate_version deployed at ${master:0:12}"
      return 0
    fi
  fi
  log "Candidate deployment failed; attempting one controlled rollback."
  new_state="$(jq --arg digest "$candidate" '.failed_digests |= (. + [$digest] | unique) | .last_failure={digest:$digest,at:(now|todateiso8601)}' <<<"$STATE")"
  write_state "$new_state"
  if apply_digest "$previous" && wait_healthy "$previous" && verify_contract; then
    after="$(sqlite_baseline)" || true
    [[ -n "$after" ]] && sqlite_compatible "$before" "$after" && rollback_ok=1
  fi
  remove_unused_digest "$candidate" "$previous" "$rollback_target"
  if (( rollback_ok == 1 )); then
    notify FAILURE "candidate ${candidate:0:19} rejected; previous image restored"
    die "deployment_failed_rollback_succeeded"
    return 1
  fi
  new_state="$(jq '.recovery_required=true | .updated_at=(now|todateiso8601)' <<<"$new_state")"
  write_state "$new_state"
  notify CRITICAL "deployment and rollback failed; manual recovery required"
  die "deployment_failed_recovery_required"
}

main() {
  require_commands
  validate_config
  mkdir -p -m 700 "$FUSION_STATE_DIR"
  exec 9>"$FUSION_STATE_DIR/updater.lock"
  flock -n 9 || { log "Another updater process is active"; exit 0; }
  case "${1:-update}" in
    snapshot-contract) snapshot_contract ;;
    bootstrap-state) bootstrap_state ;;
    recover-state) recover_state ;;
    verify) compose_preflight && verify_contract && load_state && sqlite_baseline >/dev/null ;;
    update) run_update ;;
    *) die "unknown_command" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
