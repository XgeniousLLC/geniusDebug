# geniusDebug — dashboard API (REST, JWT auth, FR-UI-*/FR-ADM-*)
# Build context is the repo ROOT: docker build -f apps/api/Dockerfile .
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm ci \
 && npm run build -w @geniusdebug/shared \
 && npm run build -w @geniusdebug/db \
 && npm run build -w @geniusdebug/api

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 4002
CMD ["node", "apps/api/dist/main.js"]
