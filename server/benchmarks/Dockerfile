# Benchmark only. Production Dockerfiles and the pinned Debian package stay unchanged.
FROM node:24.19.0-bookworm
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/playwright
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build
COPY benchmark-baseline/server/src /app/baseline/src
COPY benchmark-baseline/server/tsconfig.json /app/baseline/tsconfig.json
COPY benchmark-baseline/server/package.json /app/baseline/package.json
RUN ln -s /app/server/node_modules /app/baseline/node_modules \
    && cd /app/baseline && npm run build
COPY server/scripts/capture-performance.mjs ./scripts/capture-performance.mjs
ENV CAPTURE_BASELINE_MODULE=/app/baseline/dist/capture.js
USER node
CMD ["node", "scripts/capture-performance.mjs"]
