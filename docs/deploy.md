# Deploy without Docker

Every service is a plain Node process, so you can deploy geniusDebug on **Coolify** (Nixpacks, no
Dockerfile) or any **VPS** (pm2 / systemd) without containers. Prefer containers? See
[Self-host with Docker](self-hosting-docker.md).

geniusDebug runs on **its own infrastructure** — never share a database, Redis, or compute with the
app you're monitoring (NFR-PERF-5).

## 0. Provision

| Resource | Notes |
|---|---|
| **PostgreSQL** 14+ | managed or self-hosted; one database, e.g. `geniusdebug` |
| **Redis** 6+ | queue + rate limits + map cache |
| **Cloudflare R2** | bucket for replay recordings + source maps (S3-compatible) — optional |
| **AWS SES** | out of sandbox, verified sender domain — optional |
| **Domains** | `ingest.<you>` (public, high-traffic) · `api.<you>` · `app.<you>` (web) |

## 1. Environment

Copy `.env.example` → `.env` and fill it in. Full reference: [Configuration](configuration.md).
**Secrets are server-side only** — never in the web bundle, never committed.

```bash
DATABASE_URL=postgres://user:pass@host:5432/geniusdebug
REDIS_URL=redis://:pass@host:6379
INGEST_PORT=4001
API_PORT=4002
JWT_SECRET=<64 random hex>
APP_ENCRYPTION_KEY=<64 random hex>
API_PUBLIC_URL=https://api.<you>
WEB_URL=https://app.<you>
VITE_API_URL=https://api.<you>       # web build-time (public)
# R2_*, SES_*, GITHUB_* — optional, see Configuration
```

Generate secrets: `openssl rand -hex 32` (run once for each of `JWT_SECRET`, `APP_ENCRYPTION_KEY`).

## 2. Migrate (once per schema change)

```bash
npm ci
npm run build -w @geniusdebug/shared
npm run build -w @geniusdebug/db
npm run migrate -w @geniusdebug/db     # schema + partitioned events + partitions (idempotent)
```

## 3. Build

```bash
npm run build -w @geniusdebug/shared
npm run build -w @geniusdebug/db
npm run build -w @geniusdebug/api
npm run build -w @geniusdebug/ingest
npm run build -w @geniusdebug/workers
npm run build -w @geniusdebug/web       # static bundle in apps/web/dist
```

## 4a. Coolify (Nixpacks — no Dockerfile)

Create **one Coolify Application per service**, all pointing at this repo. Coolify auto-detects Node
via Nixpacks. Set the same env on each backend service.

| Service | Build | Start | Port | Public |
|---|---|---|---|---|
| **ingest** | `npm ci && npm run build -w @geniusdebug/shared -w @geniusdebug/db -w @geniusdebug/ingest` | `node apps/ingest/dist/main.js` | 4001 | yes → `ingest.<you>` |
| **api** | `npm ci && npm run build -w @geniusdebug/shared -w @geniusdebug/db -w @geniusdebug/api` | `node apps/api/dist/main.js` | 4002 | yes → `api.<you>` |
| **workers** | `npm ci && npm run build -w @geniusdebug/shared -w @geniusdebug/db -w @geniusdebug/workers` | `node apps/workers/dist/main.js` | — | no (background) |
| **web** | `npm ci && npm run build -w @geniusdebug/web` (set `VITE_API_URL`) | static — serve `apps/web/dist` | 80 | yes → `app.<you>` |

- For **web**, use Coolify's "Static" build (publish directory `apps/web/dist`) or any static host / CDN.
- Add PostgreSQL and Redis as Coolify **databases** and wire `DATABASE_URL` / `REDIS_URL`.
- Run **migrate** (step 2) once — as a Coolify one-off command or a pre-deploy hook on `api`.
- SPA routing: configure the web host to fall back to `index.html`.

## 4b. Plain VPS (pm2)

```bash
npm ci
# build all (step 3), migrate (step 2)
npm i -g pm2
pm2 start apps/api/dist/main.js      --name gd-api
pm2 start apps/ingest/dist/main.js   --name gd-ingest
pm2 start apps/workers/dist/main.js  --name gd-workers
pm2 save && pm2 startup
# serve apps/web/dist with nginx/caddy (SPA fallback to index.html)
```

Reverse proxy (Caddy example):

```
ingest.<you> { reverse_proxy localhost:4001 }
api.<you>    { reverse_proxy localhost:4002 }
app.<you>    { root * /var/www/geniusdebug/apps/web/dist
               try_files {path} /index.html
               file_server }
```

## 5. Source maps (per deploy of the monitored app)

In the **monitored app's** CI, run geniusDebug's uploader so frames symbolicate. Get the secret **org
upload token** once from geniusDebug → Settings → issue token.

```bash
GENIUSDEBUG_API=https://api.<you> \
GENIUSDEBUG_ORG_TOKEN=<secret> \
GENIUSDEBUG_PROJECT_ID=<project id> \
R2_BUCKET=... R2_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
RELEASE=$VERCEL_GIT_COMMIT_SHA \
node scripts/upload-sourcemaps.mjs
```

## 6. GitHub App

geniusDebug → Settings → GitHub → **Create GitHub App** (personal or org). The manifest
redirect/callback uses `API_PUBLIC_URL`, so it must be reachable from the browser. App secrets are
stored encrypted with `APP_ENCRYPTION_KEY`. Install the app on repos, then link one to a project.

## 7. Operations

- **Kill switch** — Settings → Remote config → Disable ingest. Drops events cheaply (202), no redeploy.
- **Retention / partitions** — `workers` runs a daily job that rolls monthly partitions forward and
  purges aged events/replays/maps. Manual: `npm run purge -w @geniusdebug/workers`.
- **Metrics** — Settings → System metrics (queue depth, p50/p95 latency, dropped-event counters).
- **Backups** — PostgreSQL PITR; R2 lifecycle rules aligned to retention.

## 8. Checklist

- [ ] `DATABASE_URL` / `REDIS_URL` point at geniusDebug's **own** infra (not the monitored app's)
- [ ] `JWT_SECRET` + `APP_ENCRYPTION_KEY` set (strong, unique)
- [ ] `API_PUBLIC_URL` + `WEB_URL` are the real HTTPS hosts (GitHub callbacks depend on them)
- [ ] `ingest.<you>` is publicly reachable (the SDK / tunnel posts here)
- [ ] migrations applied
- [ ] R2 + SES creds set (else replay/maps and email are inert but the core loop still works)
- [ ] web served with SPA fallback
