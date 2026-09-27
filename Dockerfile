# Multi-stage build for Read Podcast Node.js application
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:server

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/read-podcast.db \
    STORAGE_PATH=/data/storage \
    PUBLIC_PATH=/app/public

RUN mkdir -p /data && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/dist/server.js ./dist/server.js
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/migrations ./migrations

USER node

VOLUME /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/public/health || exit 1

CMD ["node", "dist/server.js"]
