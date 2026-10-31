# Puppeteer + Chromium runtime, multi-arch (linux/amd64 + linux/arm64).
#
# Why we don't use ghcr.io/puppeteer/puppeteer:* — that image only ships
# linux/amd64 manifests, so on Apple Silicon the container falls back to
# Rosetta-emulated x86 Chromium and crashes during launch (sandbox setup
# fails under emulation). Building on top of node:20-bookworm-slim and
# `apt install chromium` gives us a proper native arm64 Chromium binary.
#
# The driver supplies main.js + package.json (deps must include `puppeteer`
# + `dd-trace`). Puppeteer is told to use the system Chromium via
# PUPPETEER_EXECUTABLE_PATH so it doesn't try to download a bundled one
# at npm install time.
FROM node:20-bookworm-slim

# Chromium + the libraries it actually loads at runtime + fonts so headless
# rendering doesn't fall back to "tofu" boxes for non-ASCII text. Same
# package set the puppeteer team documents under their `troubleshoot.md`
# for Debian-family containers.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libc6 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libfontconfig1 \
      libgbm1 \
      libgcc-s1 \
      libglib2.0-0 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xdg-utils \
 && rm -rf /var/lib/apt/lists/*

# Tell puppeteer to skip its bundled Chromium download (we provide system
# Chromium) AND to use the system binary at runtime.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Run as a non-root user — Chromium's sandbox layer fails when launched as
# root, and the driver passes --no-sandbox anyway as a defense-in-depth.
RUN groupadd --system --gid 1001 pptruser \
 && useradd  --system --uid 1001 --gid pptruser --create-home pptruser

WORKDIR /home/pptruser

# Install deps first to keep the layer cache hot across iterations of
# main.js. `--omit=dev` because nothing in this driver needs devDeps.
COPY --chown=pptruser:pptruser package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Then copy the driver source.
COPY --chown=pptruser:pptruser . ./

USER pptruser

# main.js by convention; dd-trace is loaded via NODE_OPTIONS set on the
# compose service block.
CMD ["node", "main.js"]
