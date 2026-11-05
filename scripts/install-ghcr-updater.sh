#!/bin/sh
set -eu

usage() {
  echo "usage: $0 --image ghcr.io/mkaand/changd-fusion-updater@sha256:... --project NAME --project-dir DIR --compose-file FILE --compose-env FILE" >&2
  exit 2
}

image= project= project_dir= compose_file= compose_env=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) image=${2:-}; shift 2 ;;
    --project) project=${2:-}; shift 2 ;;
    --project-dir) project_dir=${2:-}; shift 2 ;;
    --compose-file) compose_file=${2:-}; shift 2 ;;
    --compose-env) compose_env=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
command -v docker >/dev/null && command -v systemctl >/dev/null || { echo "Docker and systemd are required" >&2; exit 1; }
printf '%s' "$image" | grep -Eq '^ghcr\.io/mkaand/changd-fusion-updater@sha256:[0-9a-f]{64}$' || usage
printf '%s' "$project" | grep -Eq '^[a-z0-9][a-z0-9_-]{0,62}$' || usage
for value in "$project_dir" "$compose_file" "$compose_env"; do case "$value" in /*) ;; *) usage ;; esac; done
[ -d "$project_dir" ] && [ -f "$compose_file" ] && [ -f "$compose_env" ] || { echo "Compose paths do not exist" >&2; exit 1; }
case "$(realpath "$compose_file")" in "$(realpath "$project_dir")"/*) ;; *) echo "Compose file must be inside project directory" >&2; exit 1 ;; esac
case "$(realpath "$compose_env")" in "$(realpath "$project_dir")"/*) ;; *) echo "Compose env must be inside project directory" >&2; exit 1 ;; esac

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install -d -m 0700 -o 10001 -g 10001 /var/lib/changd-fusion-updater
install -d -m 0700 /etc/changd-fusion
install -d -m 0700 /etc/changd-fusion/docker
install -m 0755 "$source_dir/scripts/run-ghcr-updater-container.sh" /usr/local/sbin/changd-fusion-updater-container
install -m 0644 "$source_dir/systemd/changd-fusion-updater.service" /etc/systemd/system/changd-fusion-updater.service
install -m 0644 "$source_dir/systemd/changd-fusion-updater.timer" /etc/systemd/system/changd-fusion-updater.timer

umask 077
cat > /etc/changd-fusion/updater.env <<EOF
FUSION_UPDATER_IMAGE=$image
FUSION_COMPOSE_PROJECT=$project
FUSION_PROJECT_DIRECTORY=$project_dir
FUSION_COMPOSE_BASE_FILE=$compose_file
FUSION_COMPOSE_OVERRIDE_FILE=/opt/changd-fusion-updater/docker-compose.ghcr.yml
FUSION_COMPOSE_ENV_FILE=$compose_env
FUSION_UPDATER_STATE_DIRECTORY=/var/lib/changd-fusion-updater
FUSION_DOCKER_CONFIG_DIRECTORY=/etc/changd-fusion/docker
FUSION_TRUSTED_REPOSITORY=mkaand/changd-fusion
FUSION_UPDATER_DRY_RUN=1
EOF
chmod 0600 /etc/changd-fusion/updater.env
systemctl daemon-reload
echo "Installed disabled in dry-run mode. Add optional credentials, verify the pinned digest, then run the service manually. The timer was not enabled."
