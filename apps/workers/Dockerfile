# geniusDebug — workers (BullMQ pipeline: normalize→symbolicate→group→persist→alert)
# Also runs DB migrations in compose (npm run db:migrate, via tsx) — devDeps kept on purpose.
# Build context is the repo ROOT: docker build -f apps/workers/Dockerfile .
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm ci \
 && npm run build -w @geniusdebug/shared \
 && npm run build -w @geniusdebug/db \
 && npm run build -w @geniusdebug/workers

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
# No HTTP port — pure queue consumer.
CMD ["node", "apps/workers/dist/main.js"]
