# syntax=docker/dockerfile:1
# Development-only image; no application credentials or checkout copied into layers.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ARG CHROMIUM_VERSION=154.0.8037.92-1~deb12u1
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium=${CHROMIUM_VERSION} chromium-sandbox=${CHROMIUM_VERSION} fonts-liberation \
    git curl ca-certificates python3 procps \
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
USER node
WORKDIR /workspaces/changd-fusion
