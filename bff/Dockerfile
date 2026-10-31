# Generic Node 20 LTS + Express runtime, dd-trace auto-instrumented.
# The service supplies main.js + package.json (deps must include dd-trace,
# express, plus whatever the app needs). This Dockerfile installs
# dependencies and runs the app under NODE_OPTIONS='-r dd-trace/init'
# (set on the compose service block, not here, so the same image can
# be re-used in topologies that override).
FROM node:20-bookworm-slim

WORKDIR /app

# Build deps for any topology that pins something native (node-rdkafka,
# bcrypt, sharp, etc.). Keep apt minimal.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

# Install deps first, then copy app sources — keeps the layer cache hot
# across iterations of main.js. If package-lock.json exists, prefer
# `npm ci` for reproducibility; otherwise fall back to `npm install`.
COPY package*.json /app/
RUN if [ -f package-lock.json ]; then npm ci --omit=dev || npm ci ; \
    else npm install --omit=dev || npm install ; fi

COPY . /app/

EXPOSE 8080

# main.js by convention; package.json's `main:` field would be more
# correct but `main.js` matches the harness contract. dd-trace is
# loaded via NODE_OPTIONS='-r dd-trace/init' set on the service block.
CMD ["node", "main.js"]
