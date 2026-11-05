#!/bin/sh
set -eu

fail() { printf '%s\n' "Changd Fusion updater launcher stopped safely: $1" >&2; exit 1; }
absolute() { case "$1" in /*) ;; *) fail "invalid_path" ;; esac; }

image=${FUSION_UPDATER_IMAGE:-}
project=${FUSION_COMPOSE_PROJECT:-}
project_dir=${FUSION_PROJECT_DIRECTORY:-}
base_file=${FUSION_COMPOSE_BASE_FILE:-}
compose_env=${FUSION_COMPOSE_ENV_FILE:-}
state_dir=${FUSION_UPDATER_STATE_DIRECTORY:-}
docker_config=${FUSION_DOCKER_CONFIG_DIRECTORY:-/etc/changd-fusion/docker}
updater_env=${FUSION_UPDATER_ENV_FILE:-/etc/changd-fusion/updater.env}

printf '%s' "$image" | grep -Eq '^ghcr\.io/mkaand/changd-fusion-updater@sha256:[0-9a-f]{64}$' || fail "invalid_updater_image"
printf '%s' "$project" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,62}$' || fail "invalid_project"
for value in "$project_dir" "$base_file" "$compose_env" "$state_dir" "$docker_config" "$updater_env"; do absolute "$value"; done
[ -d "$project_dir" ] && [ -f "$base_file" ] && [ -f "$compose_env" ] || fail "missing_compose_configuration"
[ -d "$state_dir" ] && [ -d "$docker_config" ] && [ -f "$updater_env" ] || fail "missing_updater_configuration"
[ "$(realpath "$base_file")" != "$(realpath "$project_dir")" ] || fail "invalid_compose_file"
case "$(realpath "$base_file")" in "$(realpath "$project_dir")"/*) ;; *) fail "compose_file_outside_project" ;; esac
case "$(realpath "$compose_env")" in "$(realpath "$project_dir")"/*) ;; *) fail "compose_env_outside_project" ;; esac
[ -S /var/run/docker.sock ] || fail "docker_socket_unavailable"

socket_gid=$(stat -c %g /var/run/docker.sock)
docker --host=unix:///var/run/docker.sock --config "$docker_config" image inspect "$image" >/dev/null 2>&1 \
  || docker --host=unix:///var/run/docker.sock --config "$docker_config" pull "$image" >/dev/null

# Tokens are read by Docker from the protected env file, not inherited by the
# host-side Docker CLI process or exposed as command arguments.
unset FUSION_GITHUB_TOKEN FUSION_TELEGRAM_BOT_TOKEN FUSION_TELEGRAM_CHAT_ID GH_TOKEN GITHUB_TOKEN || true

exec docker --host=unix:///var/run/docker.sock --config "$docker_config" run --rm --name changd-fusion-updater \
  --network host \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --user 10001:10001 \
  --group-add "$socket_gid" \
  --env-file "$updater_env" \
  --env FUSION_COMPOSE_OVERRIDE_FILE=/opt/changd-fusion-updater/docker-compose.ghcr.yml \
  --env DOCKER_CONFIG=/home/updater/.docker \
  --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock" \
  --mount "type=bind,src=$project_dir,dst=$project_dir,readonly" \
  --mount "type=bind,src=$state_dir,dst=$state_dir" \
  --mount "type=bind,src=$docker_config,dst=/home/updater/.docker,readonly" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /home/updater/.cache:rw,noexec,nosuid,nodev,size=16m \
  "$image"
