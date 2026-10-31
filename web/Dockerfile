# React 18 + Vite 5 SPA build pipeline for the Carto storefront.
# index.html, and src/ (must declare @datadog/browser-rum and
# @datadog/browser-rum-recorder in deps so the bundle can init the RUM
# SDK and Session Replay recorder).
#
# Two stages:
#   1. node:20-bookworm-slim — install deps, run `npm run build`. Vite
#      reads VITE_-prefixed env at build time and inlines the values
#      into the bundle, which is why DD RUM config is passed in via ARG.
#   2. nginx:1.27-alpine — serve /usr/share/nginx/html with the SPA
#      fallback config (try_files ... /index.html) so client-side
#      routing works.
#
# ARM64 clean (M-series Macs): both base images publish linux/arm64.

# ---------- Stage 1: build the bundle ----------
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Install deps first to keep the layer cache hot across iterations of
# src/. Prefer `npm ci` if a lockfile is present; fall back to
# `npm install`. Don't `--omit=dev` here — Vite + @vitejs/plugin-react
# live in devDependencies and are required for `npm run build`.
COPY package*.json /app/
RUN if [ -f package-lock.json ]; then npm ci || npm install ; \
    else npm install ; fi

# Copy the rest of the app source (index.html, src/, vite.config.*, etc.)
COPY . /app/

# DD RUM config — passed via build args from compose.fragment.yaml.
# Vite only exposes VITE_-prefixed env to client code via
# `import.meta.env`, so each ARG is promoted to ENV before `npm run
# build` runs. Empty values are valid (the topology may rebuild the
# image post-`make rum-provision` once the DD API has minted the RUM
# app id + client token).
ARG VITE_DD_RUM_APPLICATION_ID=""
ARG VITE_DD_RUM_CLIENT_TOKEN=""
ARG VITE_DD_SITE="datadoghq.com"
ARG VITE_DD_SERVICE="carto-web"
ARG VITE_DD_ENV="dev"
ARG VITE_DD_VERSION="0.0.0"
# Same-origin RUM delivery. Empty by default: RUM goes straight to intake.
# `make rum-unblock` sets this to /dd-rum for networks whose DNS blocks the
# intake hostname. An ENV referencing an UNDECLARED arg silently expands to
# empty, which is exactly how this was broken the first time.
ARG VITE_DD_RUM_PROXY=""

ENV VITE_DD_RUM_PROXY=$VITE_DD_RUM_PROXY \
    VITE_DD_RUM_APPLICATION_ID=$VITE_DD_RUM_APPLICATION_ID \
    VITE_DD_RUM_CLIENT_TOKEN=$VITE_DD_RUM_CLIENT_TOKEN \
    VITE_DD_SITE=$VITE_DD_SITE \
    VITE_DD_SERVICE=$VITE_DD_SERVICE \
    VITE_DD_ENV=$VITE_DD_ENV \
    VITE_DD_VERSION=$VITE_DD_VERSION

RUN npm run build

# ---------- Stage 2: serve the bundle ----------
FROM nginx:1.27-alpine

# SPA fallback config (client-side routing) + gzip + asset caching.
COPY nginx.conf /etc/nginx/nginx.conf

# Vite's default output is /app/dist; if the topology overrides the
# `outDir` in vite.config.* this will need to follow.
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

# nginx:alpine's default CMD is fine; leave it implicit.
