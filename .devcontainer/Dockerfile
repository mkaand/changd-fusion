# syntax=docker/dockerfile:1
# Development-only image; no application credentials or checkout copied into layers.
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
# Resolve the current matching Bookworm browser set from Debian's signed indexes.
# Exact security-version pins disappear from the live archive, so verify the
# installed browser/common/sandbox contract instead of retaining a stale pin.
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-common chromium-sandbox fonts-liberation \
    git curl ca-certificates python3 procps \
    && chromium_version="$(dpkg-query -W -f='${Version}' chromium)" \
    && chromium_common_version="$(dpkg-query -W -f='${Version}' chromium-common)" \
    && chromium_sandbox_version="$(dpkg-query -W -f='${Version}' chromium-sandbox)" \
    && [ "$chromium_version" = "$chromium_common_version" ] \
    && [ "$chromium_version" = "$chromium_sandbox_version" ] \
    && install -d -m 0755 /usr/local/share/changd-fusion \
    && printf 'chromium=%s\nchromium-common=%s\nchromium-sandbox=%s\nexecutable=%s\n' "$chromium_version" "$chromium_common_version" "$chromium_sandbox_version" "$(/usr/bin/chromium --version)" > /usr/local/share/changd-fusion/chromium-version \
    && cat /usr/local/share/changd-fusion/chromium-version \
    && find /var/lib/apt/lists -type f -delete
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export CURL_CA_BUNDLE=/run/secrets/build_ca; fi; \
    case "${TARGETARCH}" in \
      amd64) checksum=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386 ;; \
      arm64) checksum=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484 ;; \
      *) exit 1 ;; esac \
    && curl --fail --silent --show-error --location --max-time 120 \
      "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_${TARGETARCH}.tar.gz" -o /tmp/gh.tar.gz \
    && echo "${checksum}  /tmp/gh.tar.gz" | sha256sum --check \
    && tar -xzf /tmp/gh.tar.gz -C /tmp \
    && install -m 0755 "/tmp/gh_2.102.0_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -r /tmp/gh.tar.gz "/tmp/gh_2.102.0_linux_${TARGETARCH}"
# Codespaces can mount /home independently of the image. Seed a dedicated home
# volume with the exact fixed UID/GID used by lifecycle hooks and the application.
ENV HOME=/home/node XDG_CONFIG_HOME=/home/node/.config
RUN install -d -o node -g node -m 0700 /home/node \
    /home/node/.config /home/node/.config/vscode-dev-containers \
    /home/node/.vscode-server /home/node/.vscode-server-insiders
USER node
WORKDIR /workspaces/changd-fusion
