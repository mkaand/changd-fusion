FROM node:24.22.1-bookworm-slim@sha256:55fb5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:24.22.1-bookworm-slim@sha256:55fb5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS ui-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY frontend ./
RUN npm run build

FROM node:24.22.1-bookworm-slim@sha256:55fb5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ENV NODE_ENV=production PORT=3000 FUSION_DATA_DIR=/data PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends chromium chromium-common chromium-sandbox fonts-liberation && rm -rf /var/lib/apt/lists/* && mkdir -p /data && chown node:node /data
COPY --from=server-build --chown=node:node /build/server/node_modules ./node_modules
COPY --from=server-build --chown=node:node /build/server/dist ./server/dist
COPY --from=ui-build --chown=node:node /build/frontend/dist ./frontend/dist
COPY --chown=node:node simple ./simple
USER node:node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=4s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","simple/server.mjs"]
