# geniusDebug — dashboard SPA (React + Vite), served static by nginx.
# nginx reverse-proxies /api → api service, so the bundle ships with a relative base
# (VITE_API_URL=/api) and there is no CORS or build-time host to bake in.
# Build context is the repo ROOT: docker build -f apps/web/Dockerfile .
FROM node:20-slim AS build
WORKDIR /app
# Relative API base by default; override at build time for a split-origin deploy.
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
COPY . .
RUN npm ci \
 && npm run build -w @geniusdebug/shared \
 && npm run build -w @geniusdebug/web

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
