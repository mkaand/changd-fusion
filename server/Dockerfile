# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ARG CHROMIUM_VERSION=155.0.8059.39-1~deb12u1
ENV NODE_ENV=production PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium PLAYWRIGHT_BROWSERS_PATH=/ms-playwright DATA_DIR=/data
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --omit=dev && npx playwright install --with-deps webkit \
    && apt-get update && apt-get install -y --no-install-recommends chromium=${CHROMIUM_VERSION} chromium-sandbox=${CHROMIUM_VERSION} fonts-liberation \
    && find /var/lib/apt/lists -type f -delete && npm cache clean --force \
    && mkdir -p /data && chown node:node /data && chmod -R a+rX /ms-playwright
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
USER node
EXPOSE 8000
CMD ["node", "dist/index.js"]
