#!/usr/bin/env bash
set -euo pipefail

# Synthetic fixture only. Proves real Docker bind layering at UID 10001.
[[ "$EUID" -eq 0 ]] || { echo "smoke_requires_root" >&2; exit 1; }
root=$(mktemp -d /run/changd-private-smoke.XXXXXXXX)
chmod 0755 "$root"
cleanup() { rm -rf -- "$root"; }
trap cleanup EXIT

project="$root/project"
private="$project/private"
view="$root/view"
mkdir -m 0755 "$project"
mkdir -m 0700 "$private" "$view"
cat > "$project/compose.yml" <<'COMPOSE'
name: changd-smoke
services:
  probe:
    image: alpine:3.21
    environment:
      X_TEST: ${X_TEST:?missing}
COMPOSE
# The profile is intentionally root-owned inside a 0700 private directory,
# and Compose uses its absolute host path as in the production legacy layout.
cp docker/chromium-seccomp.json "$private/chromium-seccomp.json"
chmod 0600 "$private/chromium-seccomp.json"
sed -i "/^    environment:/i\\    security_opt: [\\"seccomp=$private/chromium-seccomp.json\\"]" "$project/compose.yml"
printf '%s\n' 'X_TEST=synthetic-only' > "$private/runtime.env"
chmod 0600 "$project/compose.yml" "$private/runtime.env"
mkdir -m 0700 "$view/private"
install -m 0400 -o 10001 -g 10001 "$project/compose.yml" "$view/compose.yml"
install -m 0400 -o 10001 -g 10001 "$private/runtime.env" "$view/private/runtime.env"
install -m 0400 -o 10001 -g 10001 "$private/chromium-seccomp.json" "$view/private/chromium-seccomp.json"
chown 10001:10001 "$view/private"
image=changd-fusion-updater:ci
socket_gid=$(stat -c %g /var/run/docker.sock)
mkdir -m 0700 "$root/docker-config"
printf '%s\n' '{"auths":{"ghcr.io":{"auth":"c3ludGhldGljOnRlc3Q="}}}' > "$root/docker-config/config.json"
chmod 0600 "$root/docker-config/config.json"
mkdir -m 0700 "$view/docker-config"
install -m 0400 -o 10001 -g 10001 "$root/docker-config/config.json" "$view/docker-config/config.json"
chown 10001:10001 "$view/docker-config"

# Before overlays, UID 10001 must NOT be able to read root-owned inputs.
if docker run --rm --user 10001:10001 \
  --mount "type=bind,src=$project,dst=$project,readonly" \
  --entrypoint /bin/sh "$image" -c \
  "test -r '$project/compose.yml' && test -r '$private/runtime.env'" >/dev/null 2>&1; then
  echo "baseline_permissions_not_root_only" >&2
  exit 1
fi

# The legacy launcher mounted root-owned 0700 Docker config directly; non-root
# CLI must not see it. The staged credential file must not be user-readable
# before the overlay and must be 0400, UID 10001 afterwards.
if docker run --rm --user 10001:10001 \
  --mount "type=bind,src=$root/docker-config,dst=/home/updater/.docker,readonly" \
  --entrypoint /bin/sh "$image" -c 'test -r /home/updater/.docker/config.json' >/dev/null 2>&1; then
  echo "docker_config_permissions_not_root_only" >&2
  exit 1
fi

# The project root and file identities remain unchanged; the nested private
# directory is overlaid as a directory to allow the UID to traverse its 0700 mode.
docker run --rm --user 10001:10001 --group-add "$socket_gid" --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock" \
  --mount "type=bind,src=$view/docker-config,dst=/home/updater/.docker,readonly" \
  --env "DOCKER_CONFIG=/home/updater/.docker" \
  --mount "type=bind,src=$project,dst=$project,readonly" \
  --mount "type=bind,src=$view/compose.yml,dst=$project/compose.yml,readonly" \
  --mount "type=bind,src=$view/private,dst=$private,readonly" \
  --env "FUSION_COMPOSE_BASE_FILE=$project/compose.yml" \
  --env "FUSION_COMPOSE_ENV_FILE=$private/runtime.env" \
  --env "FUSION_PROJECT_DIRECTORY=$project" \
  --env "FUSION_SECCOMP_PROFILE_FILE=$private/chromium-seccomp.json" \
  --entrypoint /bin/sh "$image" -c '
    test "$(id -u)" = 10001 &&
    test -r "$FUSION_COMPOSE_BASE_FILE" &&
    test -r "$FUSION_COMPOSE_ENV_FILE" &&
    test "$(stat -c %a "$FUSION_COMPOSE_BASE_FILE")" = 400 &&
    test "$(stat -c %a "$FUSION_COMPOSE_ENV_FILE")" = 400 &&
    test "$(stat -c %a "$(dirname "$FUSION_COMPOSE_ENV_FILE")")" = 700 &&
    test -r "$FUSION_SECCOMP_PROFILE_FILE" &&
    test "$(stat -c %a "$FUSION_SECCOMP_PROFILE_FILE")" = 400 &&
    node --input-type=module -e "import { validateTrustedSeccompProfile } from \\"/opt/changd-fusion-updater/scripts/docker-compose-adapter.mjs\\"; validateTrustedSeccompProfile(process.env.FUSION_PROJECT_DIRECTORY, \\"seccomp=\\" + process.env.FUSION_SECCOMP_PROFILE_FILE);" &&
    test "$(stat -c %u /home/updater/.docker)" = 10001 &&
    test "$(stat -c %a /home/updater/.docker)" = 700 &&
    test "$(stat -c %u /home/updater/.docker/config.json)" = 10001 &&
    test "$(stat -c %a /home/updater/.docker/config.json)" = 400 &&
    node --input-type=module -e "import { validateDockerCliConfiguration } from \"/opt/changd-fusion-updater/scripts/ghcr-updater-runtime.mjs\"; validateDockerCliConfiguration();" &&
    docker --host=unix:///var/run/docker.sock info --format "{{.ServerVersion}}" >/dev/null &&
    docker --host=unix:///var/run/docker.sock compose --project-name changd-smoke \
      --project-directory "$(dirname "$FUSION_COMPOSE_BASE_FILE")" \
      --file "$FUSION_COMPOSE_BASE_FILE" --env-file "$FUSION_COMPOSE_ENV_FILE" \
      config --format json >/dev/null
  '

[[ "$(stat -c %a "$private")" == 700 ]]
[[ "$(stat -c %a "$private/runtime.env")" == 600 ]]
[[ "$(stat -c %a "$private/chromium-seccomp.json")" == 600 ]]
[[ "$(stat -c %a "$project/compose.yml")" == 600 ]]


# Exercise the actual host launcher with an isolated Docker shim. The real
# Docker smoke above proves kernel mount semantics; this checks that the shell
# launcher builds those mounts and destroys its own sensitive snapshots.
mkdir -m 0700 "$root/mock-bin" "$root/updater-state"
updater_ref="ghcr.io/mkaand/changd-fusion-updater@sha256:$(printf '%064d' 0)"
cat > "$root/updater.env" <<EOF
FUSION_UPDATER_IMAGE=$updater_ref
FUSION_COMPOSE_PROJECT=changd_smoke
FUSION_PROJECT_DIRECTORY=$project
FUSION_COMPOSE_BASE_FILE=$project/compose.yml
FUSION_COMPOSE_ENV_FILE=$private/runtime.env
FUSION_UPDATER_STATE_DIRECTORY=$root/updater-state
FUSION_UPDATER_DRY_RUN=1
EOF
chmod 0600 "$root/updater.env"
cat > "$root/mock-bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" image inspect "*) exit 0 ;;
  *" run "*)
    count=0
    for arg in "$@"; do
      case "$arg" in
        type=bind,src=/run/changd-fusion-updater.*)
          [[ "$arg" == *,readonly ]] || exit 71
          source_path=$(printf '%s' "$arg" | cut -d, -f2 | cut -c5-)
          [[ "$(stat -c %u "$source_path")" == 10001 ]] || exit 72
          if [[ -d "$source_path" ]]; then
            [[ "$(stat -c %a "$source_path")" == 700 ]] || exit 73
          else
            [[ "$(stat -c %a "$source_path")" == 400 ]] || exit 74
          fi
          count=$((count + 1))
          ;;
      esac
    done
    [[ "$count" -eq 3 ]] || exit 75
    staged_profile=0
    for arg in "$@"; do
      case "$arg" in
        type=bind,src=/run/changd-fusion-updater.*/view/private,dst=*,readonly)
          staged_path=$(printf '%s' "$arg" | cut -d, -f2 | cut -c5-)
          [[ -f "$staged_path/chromium-seccomp.json" ]] || exit 85
          [[ "$(stat -c %u "$staged_path/chromium-seccomp.json")" == 10001 ]] || exit 86
          [[ "$(stat -c %a "$staged_path/chromium-seccomp.json")" == 400 ]] || exit 87
          staged_profile=1
          ;;
      esac
    done
    [[ "$staged_profile" -eq 1 ]] || exit 88
    [[ "$FUSION_TEST_FAIL_RUN" != 1 ]] || exit 37
    exit 0 ;;
  *) exit 76 ;;
esac
MOCK
chmod 0755 "$root/mock-bin/docker"
export PATH="$root/mock-bin:$PATH"
export FUSION_UPDATER_IMAGE="$updater_ref"
export FUSION_COMPOSE_PROJECT=changd_smoke
export FUSION_PROJECT_DIRECTORY="$project"
export FUSION_COMPOSE_BASE_FILE="$project/compose.yml"
export FUSION_COMPOSE_ENV_FILE="$private/runtime.env"
export FUSION_SECCOMP_PROFILE_FILE="$private/chromium-seccomp.json"
export FUSION_UPDATER_STATE_DIRECTORY="$root/updater-state"
export FUSION_DOCKER_CONFIG_DIRECTORY="$root/docker-config"
export FUSION_UPDATER_ENV_FILE="$root/updater.env"
export FUSION_UPDATER_DRY_RUN=1
export FUSION_TEST_FAIL_RUN=0
before=$(find /run -maxdepth 1 -type d -name 'changd-fusion-updater.*' -printf '%f\n' | sort)
sh scripts/run-ghcr-updater-container.sh
[[ "$(find /run -maxdepth 1 -type d -name 'changd-fusion-updater.*' -printf '%f\n' | sort)" == "$before" ]] || exit 77
set +e
FUSION_TEST_FAIL_RUN=1 sh scripts/run-ghcr-updater-container.sh
failure=$?
set -e
[[ "$failure" -eq 37 ]] || exit 78
[[ "$(find /run -maxdepth 1 -type d -name 'changd-fusion-updater.*' -printf '%f\n' | sort)" == "$before" ]] || exit 79

[[ "$(stat -c %a "$root/docker-config")" == 700 ]]
[[ "$(stat -c %a "$root/docker-config/config.json")" == 600 ]]
[[ "$(stat -c %a "$private")" == 700 ]]
[[ "$(stat -c %a "$private/runtime.env")" == 600 ]]



# Explicitly test absent Docker config (public GHCR), symlink rejection and
# no sensitive /run staging debris on both safe exits.
mv "$root/docker-config/config.json" "$root/docker-config/config.saved"
FUSION_TEST_FAIL_RUN=0 sh scripts/run-ghcr-updater-container.sh
[[ "$(find /run -maxdepth 1 -type d -name 'changd-fusion-updater.*' -printf '%f\n' | sort)" == "$before" ]] || exit 80
ln -s config.saved "$root/docker-config/config.json"
set +e
FUSION_TEST_FAIL_RUN=0 sh scripts/run-ghcr-updater-container.sh >"$root/rejected.log" 2>&1
symlink_exit=$?
set -e
[[ "$symlink_exit" -ne 0 ]] || exit 81
grep -q "invalid_docker_config_file" "$root/rejected.log" || exit 82
[[ "$(find /run -maxdepth 1 -type d -name 'changd-fusion-updater.*' -printf '%f\n' | sort)" == "$before" ]] || exit 83
rm "$root/docker-config/config.json"
mv "$root/docker-config/config.saved" "$root/docker-config/config.json"

# The host launcher must refuse symlink profiles before staging or Docker run.
mv "$private/chromium-seccomp.json" "$private/chromium-seccomp.original"
ln -s chromium-seccomp.original "$private/chromium-seccomp.json"
set +e
FUSION_TEST_FAIL_RUN=0 sh scripts/run-ghcr-updater-container.sh > "$root/invalid-seccomp.log" 2>&1
bad_profile_exit=$?
set -e
[[ "$bad_profile_exit" -ne 0 ]] || exit 89
grep -q "invalid_seccomp_profile" "$root/invalid-seccomp.log" || exit 90
[[ "$(find /run -maxdepth 1 -type d -name 'changd-fusion-updater.*' -printf '%f\n' | sort)" == "$before" ]] || exit 91
rm "$private/chromium-seccomp.json"
mv "$private/chromium-seccomp.original" "$private/chromium-seccomp.json"

echo "Updater private Compose/env real UID-10001 Docker mount smoke PASS"
