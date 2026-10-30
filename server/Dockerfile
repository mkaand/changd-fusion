# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
# Resolve the current matching Bookworm browser set from Debian's signed indexes.
# Exact security-version pins disappear from the live archive, so verify the
# installed browser/common/sandbox contract instead of retaining a stale pin.
ARG APP_COMMIT=development
ENV NODE_ENV=production PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium DATA_DIR=/data APP_COMMIT=${APP_COMMIT}
LABEL org.opencontainers.image.revision=${APP_COMMIT}
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev && apt-get update && apt-get install -y --no-install-recommends chromium chromium-common chromium-sandbox fonts-liberation \
    && chromium_version="$(dpkg-query -W -f='${Version}' chromium)" \
    && chromium_common_version="$(dpkg-query -W -f='${Version}' chromium-common)" \
    && chromium_sandbox_version="$(dpkg-query -W -f='${Version}' chromium-sandbox)" \
    && [ "$chromium_version" = "$chromium_common_version" ] \
    && [ "$chromium_version" = "$chromium_sandbox_version" ] \
    && mkdir -p /usr/local/share/changd-fusion \
    && printf 'chromium=%s\nchromium-common=%s\nchromium-sandbox=%s\nexecutable=%s\n' "$chromium_version" "$chromium_common_version" "$chromium_sandbox_version" "$(/usr/bin/chromium --version)" > /usr/local/share/changd-fusion/chromium-version \
    && cat /usr/local/share/changd-fusion/chromium-version \
    && find /var/lib/apt/lists -type f -delete && npm cache clean --force \
    && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
