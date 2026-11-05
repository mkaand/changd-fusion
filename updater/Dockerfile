# syntax=docker/dockerfile:1
FROM docker:28.4.0-cli@sha256:6a73c9433f2ba4279815be1e60f5739288b939dda1e48151d8c393537802de37 AS docker-cli

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

ARG GH_VERSION=2.103.3
ARG GH_ARCHIVE_SHA256=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG APP_COMMIT=development
ARG APP_VERSION=0.4.0

LABEL org.opencontainers.image.source="https://github.com/mkaand/changd-fusion" \
      org.opencontainers.image.revision="$APP_COMMIT" \
      org.opencontainers.image.version="$APP_VERSION"

RUN --mount=type=secret,id=proxy_ca,required=false \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && archive="gh_${GH_VERSION}_linux_amd64.tar.gz" \
    && if [ -s /run/secrets/proxy_ca ]; then curl_ca="--cacert /run/secrets/proxy_ca"; else curl_ca=""; fi \
    && curl $curl_ca --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      --output "/tmp/${archive}" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${archive}" \
    && printf '%s  %s\n' "$GH_ARCHIVE_SHA256" "/tmp/${archive}" | sha256sum --check - \
    && tar -xzf "/tmp/${archive}" -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /var/lib/apt/lists/* /tmp/gh_* \
    && groupadd --gid 10001 updater \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/updater --shell /usr/sbin/nologin updater \
    && install -d -o 10001 -g 10001 -m 0700 /home/updater/.docker

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

WORKDIR /opt/changd-fusion-updater
COPY updater/package.json updater/package-lock.json ./updater/
RUN --mount=type=secret,id=proxy_ca,required=false \
    if [ -s /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi \
    && cd updater && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY scripts/deployment-state.mjs \
     scripts/docker-compose-adapter.mjs \
     scripts/ghcr-ci-gate.mjs \
     scripts/ghcr-updater-runtime.mjs \
     scripts/ghcr-updater.mjs \
     scripts/github-release-client.mjs \
     scripts/maintenance-coordinator.mjs \
     scripts/release-trust.mjs \
     scripts/updater-telegram.mjs \
     ./scripts/
COPY docker-compose.ghcr.yml ./docker-compose.ghcr.yml

ENV NODE_ENV=production \
    HOME=/home/updater \
    XDG_CACHE_HOME=/home/updater/.cache \
    XDG_CONFIG_HOME=/home/updater/.config \
    FUSION_COMPOSE_OVERRIDE_FILE=/opt/changd-fusion-updater/docker-compose.ghcr.yml

USER 10001:10001
ENTRYPOINT ["node", "/opt/changd-fusion-updater/scripts/ghcr-updater-runtime.mjs"]
