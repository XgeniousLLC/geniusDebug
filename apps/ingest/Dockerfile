# geniusDebug — ingest service (Sentry envelope hot path, FR-ING-*)
# Build context is the repo ROOT (npm workspaces): docker build -f apps/ingest/Dockerfile .
FROM node:20-slim AS build
WORKDIR /app

# Whole workspace: npm ci needs every package.json + the lockfile present.
COPY . .
# Install all deps (incl. dev — needed to compile TS), then build only what ingest needs.
RUN npm ci \
 && npm run build -w @geniusdebug/shared \
 && npm run build -w @geniusdebug/db \
 && npm run build -w @geniusdebug/ingest

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# node_modules holds workspace symlinks (@geniusdebug/shared|db → their dist), so copy the tree whole.
COPY --from=build /app /app
EXPOSE 4001
# tini-free: node is PID 1; compose sends SIGTERM, Nest handles graceful shutdown.
CMD ["node", "apps/ingest/dist/main.js"]
