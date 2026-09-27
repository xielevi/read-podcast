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
    MANUSCRIPT_PATH=/data/manuscripts \
    PUBLIC_PATH=/app/public

RUN apk add --no-cache su-exec \
    && mkdir -p /data/manuscripts \
    && chown -R node:node /data /app

COPY --from=builder --chown=node:node /app/dist/server.js ./dist/server.js
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/read-podcast-entrypoint

# Entrypoint only uses root to fix ownership of a newly-created bind mount, then immediately
# drops to the unprivileged node user before starting the application.
ENTRYPOINT ["read-podcast-entrypoint"]

VOLUME /data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/public/health || exit 1

CMD ["node", "dist/server.js"]
