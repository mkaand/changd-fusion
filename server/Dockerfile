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
# Keep browser/common/sandbox aligned with the authenticated Bookworm security update.
ARG CHROMIUM_VERSION=156.0.8078.47-1~deb12u1
ENV NODE_ENV=production PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium DATA_DIR=/data
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev && apt-get update && apt-get install -y --no-install-recommends chromium=${CHROMIUM_VERSION} chromium-common=${CHROMIUM_VERSION} chromium-sandbox=${CHROMIUM_VERSION} fonts-liberation \
    && find /var/lib/apt/lists -type f -delete && npm cache clean --force \
    && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
