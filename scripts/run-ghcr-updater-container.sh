#!/bin/sh
set -eu
umask 077

fail() { printf '%s\n' "Changd Fusion updater launcher stopped safely: $1" >&2; exit 1; }
absolute() { case "$1" in /*) ;; *) fail "invalid_path" ;; esac; }

# Only an explicit operator invocation can request signed installed-release adoption.
adopt_mode=
adopt_source=
case "$#" in
  0) ;;
  2)
    [ "$1" = "--adopt-installed" ] || fail "invalid_argument"
    printf '%s' "$2" | grep -Eq '^[0-9a-f]{40}$' || fail "invalid_adoption_source"
    adopt_mode="$1"
    adopt_source="$2"
    ;;
  *) fail "invalid_argument" ;;
esac

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
for value in "$project_dir" "$base_file" "$compose_env" "$state_dir" "$docker_config" "$updater_env"; do
  absolute "$value"
  if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:],]'; then fail "invalid_path"; fi
done
[ -d "$project_dir" ] && [ -f "$base_file" ] && [ -f "$compose_env" ] || fail "missing_compose_configuration"
[ -d "$state_dir" ] && [ -d "$docker_config" ] && [ -f "$updater_env" ] || fail "missing_updater_configuration"
[ -S /var/run/docker.sock ] || fail "docker_socket_unavailable"

# The host Docker credential directory is root-owned (usually 0700). Never
# bind that directory directly into a non-root updater: Docker CLI cannot read
# it, and copying arbitrary context/helper files would widen credential scope.
[ ! -L "$docker_config" ] || fail "invalid_docker_config_directory"
docker_config=$(realpath -- "$docker_config") || fail "invalid_docker_config_directory"
[ -d "$docker_config" ] && [ "$(stat -c %u "$docker_config")" = 0 ] \
  || fail "invalid_docker_config_directory"
config_file="$docker_config/config.json"
if [ -e "$config_file" ] || [ -L "$config_file" ]; then
  [ ! -L "$config_file" ] && [ -f "$config_file" ] \
    && [ "$(stat -c %u "$config_file")" = 0 ] \
    && [ "$(stat -c %h "$config_file")" = 1 ] \
    && [ "$(stat -c %s "$config_file")" -le 131072 ] \
    || fail "invalid_docker_config_file"
fi

# Resolve symlinks before staging and preserve the exact host-side paths used
# by existing Compose ownership labels. The project root remains a read-only
# host bind; only explicitly selected files/directories are overlaid.
project_dir=$(realpath -- "$project_dir") || fail "invalid_project_directory"
base_file=$(realpath -- "$base_file") || fail "invalid_compose_file"
compose_env=$(realpath -- "$compose_env") || fail "invalid_compose_env"
case "$base_file" in "$project_dir"/*) ;; *) fail "compose_file_outside_project" ;; esac
case "$compose_env" in "$project_dir"/*) ;; *) fail "compose_env_outside_project" ;; esac
[ "$base_file" != "$compose_env" ] || fail "ambiguous_compose_files"

base_rel=${base_file#"$project_dir"/}
env_rel=${compose_env#"$project_dir"/}
# The checked-in base Compose file must be in the project root. A private env
# file may be in a root-only nested directory, which must be overlaid as a
# directory to allow UID 10001 to traverse it.
case "$base_rel" in */*) fail "unsupported_nested_compose_file" ;; esac
[ -n "$base_rel" ] && [ -n "$env_rel" ] || fail "invalid_compose_file"

# The checked-in docker/chromium-seccomp.json remains readable through the
# original project mount. For a root-only project private/ profile, stage it
# beside the protected runtime.env. Other projects can explicitly configure an
# absolute, project-contained FUSION_SECCOMP_PROFILE_FILE.
seccomp_profile=${FUSION_SECCOMP_PROFILE_FILE:-}
if [ -z "$seccomp_profile" ] && [ -f "$project_dir/private/chromium-seccomp.json" ]; then
  seccomp_profile="$project_dir/private/chromium-seccomp.json"
fi
seccomp_rel=
if [ -n "$seccomp_profile" ]; then
  absolute "$seccomp_profile"
  if printf '%s' "$seccomp_profile" | LC_ALL=C grep -q '[[:cntrl:],]'; then fail "invalid_seccomp_profile"; fi
  [ ! -L "$seccomp_profile" ] && [ -f "$seccomp_profile" ] \
    && [ "$(stat -c %h "$seccomp_profile")" = 1 ] \
    && [ "$(stat -c %s "$seccomp_profile")" -le 1048576 ] \
    || fail "invalid_seccomp_profile"
  profile_canonical=$(realpath -- "$seccomp_profile") || fail "invalid_seccomp_profile"
  [ "$seccomp_profile" = "$profile_canonical" ] || fail "invalid_seccomp_profile"
  case "$profile_canonical" in "$project_dir"/*) ;; *) fail "seccomp_profile_outside_project" ;; esac
  seccomp_rel=${profile_canonical#"$project_dir"/}
  [ "$seccomp_rel" != "$base_rel" ] && [ "$seccomp_rel" != "$env_rel" ] \
    || fail "ambiguous_seccomp_profile"
fi

socket_gid=$(stat -c %g /var/run/docker.sock)
docker --host=unix:///var/run/docker.sock --config "$docker_config" image inspect "$image" >/dev/null 2>&1 \
  || docker --host=unix:///var/run/docker.sock --config "$docker_config" pull "$image" >/dev/null

# The root-owned staging parent is never mounted. Only its UID-10001-owned
# child files/subdirectories become visible at the ORIGINAL container paths.
# Production permissions, UID/GID, Compose ownership and env secrets stay
# unchanged. Mount source paths are randomly named and deleted on all exits.
stage_root=$(mktemp -d /run/changd-fusion-updater.XXXXXXXXXX) || fail "staging_unavailable"
child=
cleanup() { rm -rf -- "$stage_root"; }
on_signal() {
  trap - HUP INT TERM
  if [ -n "$child" ]; then
    if [ -s "$stage_root/cid" ]; then
      cid=$(cat "$stage_root/cid" 2>/dev/null || :)
      if printf '%s' "$cid" | grep -Eq '^[0-9a-f]{64}$'; then
        docker --host=unix:///var/run/docker.sock --config "$docker_config" stop -t 20 "$cid" >/dev/null 2>&1 || :
      fi
    fi
    kill -TERM "$child" 2>/dev/null || :
    wait "$child" 2>/dev/null || :
  fi
  exit 143
}
trap cleanup EXIT
trap on_signal HUP INT TERM

mkdir -m 0700 "$stage_root/view" || fail "staging_unavailable"
mkdir -p -- "$(dirname -- "$stage_root/view/$env_rel")" || fail "staging_unavailable"
install -m 0400 -o 10001 -g 10001 "$base_file" "$stage_root/view/$base_rel" || fail "staging_failed"
install -m 0400 -o 10001 -g 10001 "$compose_env" "$stage_root/view/$env_rel" || fail "staging_failed"
if [ -n "$seccomp_rel" ]; then
  mkdir -p -- "$(dirname -- "$stage_root/view/$seccomp_rel")" || fail "staging_failed"
  install -m 0400 -o 10001 -g 10001 "$profile_canonical" "$stage_root/view/$seccomp_rel" \
    || fail "staging_failed"
fi
# mkdir -p uses 0755 for intermediate components on some platforms; tighten
# EVERY staged directory, not only the leaf.
chown -R 10001:10001 "$stage_root/view" || fail "staging_failed"
find "$stage_root/view" -type d -exec chmod 0700 {} + || fail "staging_failed"

# Stage only the explicitly configured Docker config.json, if one exists.
# The stage is private to UID 10001, read-only in the container and removed
# by the existing EXIT/signal cleanup traps. No original permission is changed.
mkdir -m 0700 "$stage_root/docker-config" || fail "staging_unavailable"
chown 10001:10001 "$stage_root/docker-config" || fail "staging_failed"
if [ -f "$config_file" ]; then
  install -m 0400 -o 10001 -g 10001 "$config_file" "$stage_root/docker-config/config.json" \
    || fail "staging_failed"
fi

# Tokens are passed to Docker via the protected updater env file, not via CLI
# arguments or inherited environment. The base/runtime Compose env snapshot is
# mounted only read-only and never printed.
unset FUSION_GITHUB_TOKEN FUSION_TELEGRAM_BOT_TOKEN FUSION_TELEGRAM_CHAT_ID GH_TOKEN GITHUB_TOKEN || true

set -- \
  --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock" \
  --mount "type=bind,src=$project_dir,dst=$project_dir,readonly" \
  --mount "type=bind,src=$state_dir,dst=$state_dir" \
  --mount "type=bind,src=$stage_root/docker-config,dst=/home/updater/.docker,readonly" \
  --mount "type=bind,src=$stage_root/view/$base_rel,dst=$base_file,readonly"

case "$env_rel" in
  */*)
    env_top=${env_rel%%/*}
    set -- "$@" --mount "type=bind,src=$stage_root/view/$env_top,dst=$project_dir/$env_top,readonly"
    ;;
  *)
    set -- "$@" --mount "type=bind,src=$stage_root/view/$env_rel,dst=$compose_env,readonly"
    ;;
esac

# Overlay the profile at its ORIGINAL absolute path. The existing nested
# environment overlay may already expose its staging directory.
if [ -n "$seccomp_rel" ]; then
  case "$seccomp_rel" in
    */*)
      profile_top=${seccomp_rel%%/*}
      if [ "${env_top:-}" != "$profile_top" ]; then
        set -- "$@" --mount "type=bind,src=$stage_root/view/$profile_top,dst=$project_dir/$profile_top,readonly"
      fi
      ;;
    *)
      set -- "$@" --mount "type=bind,src=$stage_root/view/$seccomp_rel,dst=$profile_canonical,readonly"
      ;;
  esac
fi

# Keep the launcher alive while Docker runs so EXIT and signal traps remove
# the secret snapshots. A container ID file only identifies this invocation,
# never another Compose project or a pre-existing updater container.
docker --host=unix:///var/run/docker.sock --config "$docker_config" run --rm --name changd-fusion-updater \
  --cidfile "$stage_root/cid" \
  --network host \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --user 10001:10001 \
  --group-add "$socket_gid" \
  --env-file "$updater_env" \
  --env FUSION_PROJECT_DIRECTORY="$project_dir" \
  --env FUSION_COMPOSE_BASE_FILE="$base_file" \
  --env FUSION_COMPOSE_ENV_FILE="$compose_env" \
  --env FUSION_COMPOSE_OVERRIDE_FILE=/opt/changd-fusion-updater/docker-compose.ghcr.yml \
  --env DOCKER_CONFIG=/home/updater/.docker \
  "$@" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /home/updater/.cache:rw,noexec,nosuid,nodev,size=16m \
  "$image" ${adopt_mode:+"$adopt_mode"} ${adopt_source:+"$adopt_source"} &
child=$!
set +e
wait "$child"
status=$?
set -e
child=
exit "$status"
