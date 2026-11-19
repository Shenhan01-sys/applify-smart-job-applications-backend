# Image backend Applify (Fastify, TypeScript). Dipakai Railway, docker compose, dan EC2.
# Tiga tahap:
#   build      memasang SEMUA dependency (tsc ada di devDependencies) lalu menjalankan `npm run build`
#   prod-deps  memasang dependency produksi saja
#   production tahap akhir: hanya dist, node_modules produksi, package.json, dan config/job-boards.json

FROM node:22-alpine AS build
WORKDIR /app
# Playwright tidak perlu mengunduh browser; image akhir memakai Chromium dari paket Alpine.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS production
WORKDIR /app

# Chromium sistem untuk klien portal berbasis browser (LinkedIn, cadangan Glints).
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV NODE_ENV=production \
    PORT=4000 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Daftar papan lowongan dibaca saat jalan (services/mcp-registry.ts). Tanpa berkas ini daftarnya diam-diam kosong.
COPY --chown=node:node config ./config

USER node

# Railway menyuntikkan PORT. Server mendengarkan 0.0.0.0:$PORT.
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/api/index.js"]
