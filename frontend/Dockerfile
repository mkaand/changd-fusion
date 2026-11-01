# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
ARG APP_COMMIT=""
ARG APP_BRANCH=""
ARG APP_SOURCE_PR=""
ENV VITE_APP_COMMIT=${APP_COMMIT} \
    VITE_APP_BRANCH=${APP_BRANCH} \
    VITE_APP_SOURCE_PR=${APP_SOURCE_PR}
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run build
FROM nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
LABEL org.opencontainers.image.source="https://github.com/mkaand/changd-fusion"
COPY --chown=101:101 nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
EXPOSE 8080
