# End-to-end deployment guide

A complete, copy-paste walkthrough to run geniusDebug in production — from a bare server to a live
dashboard receiving errors from your app. If you just want it running locally, use
[Self-host with Docker](self-hosting-docker.md) instead; this guide is for a real, internet-facing
deployment.

!!! abstract "What you'll end up with"
    Three public HTTPS hosts — `ingest.<you>` (event intake), `api.<you>` (dashboard API),
    `app.<you>` (dashboard UI) — a background `workers` process, plus PostgreSQL and Redis. Your app
    keeps its existing Sentry SDK and just points its DSN at geniusDebug.

!!! danger "Golden rule — run on separate infra"
    geniusDebug must **never** share a database, Redis, or server with the app it monitors (NFR-PERF-5).
    If geniusDebug is slow or down, the monitored app must be completely unaffected. Provision a
    dedicated VPS / managed datastores for it.

**Reading order:** [1. VPS](#1-initial-setup-on-a-dedicated-vps) → [2. The four apps](#2-the-four-apps) →
[3. Coolify](#3-deploy-on-coolify) *or* [4. AWS / DigitalOcean](#4-deploy-on-aws-or-digitalocean) →
[5. Create a project & wire your SDK](#5-set-up-a-project-and-use-your-existing-sentry-sdk) →
[6. After-deploy checklist](#6-what-you-must-configure-after-deploy).

---

## 1. Initial setup on a dedicated VPS

Applies to any Ubuntu 22.04+ box — a DigitalOcean Droplet, AWS EC2, Hetzner, Linode, etc. Skip this
section if you deploy with a PaaS like Coolify (§3) that manages the host for you.

### 1.1 Size the box

| Load | vCPU / RAM | Notes |
|---|---|---|
| Small team, < ~50 events/s | **2 vCPU / 4 GB** | comfortable for all four apps + local Postgres/Redis. |
| Higher traffic | 4 vCPU / 8 GB, or split datastores off to managed | scale `workers` first (it does the heavy pipeline work). |

Add ~20 GB disk (events are time-partitioned and purged on a retention schedule, so growth is bounded).

### 1.2 Create a non-root user + firewall

```bash
# as root on a fresh box
adduser genius && usermod -aG sudo genius
# firewall: SSH + HTTP/HTTPS only — datastores stay local
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

Log back in as `genius`. Everything below runs as this user.

### 1.3 Install the runtime

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# PostgreSQL 16 + Redis 7 (local — or use managed, see §4)
sudo apt-get install -y postgresql redis-server
sudo systemctl enable --now postgresql redis-server
```

!!! warning "Do not set `NODE_ENV=production` before installing"
    Migrations run through `tsx` (a dev dependency). If `NODE_ENV=production` is set during
    `npm ci`, dev deps are pruned and `db:migrate` fails with "tsx: not found". Install with dev deps
    present; you can export `NODE_ENV=production` afterwards for the runtime if you like.

### 1.4 Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER genius WITH PASSWORD 'CHANGE_ME_STRONG';
CREATE DATABASE geniusdebug OWNER genius;
SQL
```

Your `DATABASE_URL` is then `postgres://genius:CHANGE_ME_STRONG@localhost:5432/geniusdebug`.
For Redis with a password, set `requirepass` in `/etc/redis/redis.conf` and use
`redis://:PASS@localhost:6379`.

### 1.5 Clone, configure, build, migrate

```bash
git clone https://github.com/XgeniousLLC/geniusDebug.git
cd geniusDebug
cp .env.example .env
```

Generate the two required secrets and put them in `.env`:

```bash
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 32   # → APP_ENCRYPTION_KEY
```

Minimum `.env` for a single-box deploy (full reference: [Configuration](configuration.md)):

```bash
DATABASE_URL=postgres://genius:CHANGE_ME_STRONG@localhost:5432/geniusdebug
REDIS_URL=redis://:REDIS_PASS@localhost:6379
JWT_SECRET=<64 hex>
APP_ENCRYPTION_KEY=<64 hex>
INGEST_PORT=4001
API_PORT=4002
API_PUBLIC_URL=https://api.<you>
WEB_URL=https://app.<you>
VITE_API_URL=https://api.<you>     # baked into the web bundle at build time
```

Build and apply the schema:

```bash
npm ci                       # dev deps included (tsx needed for migrate)
npm run build                # shared + db + all apps + web bundle
npm run db:migrate           # schema + partitioned events table + partitions (idempotent)
```

`db:migrate` is safe to re-run — it only applies what's missing. Continue to
[§2 the four apps](#2-the-four-apps) to start them, then front them with TLS (§4.3).

---

## 2. The four apps

geniusDebug is a monorepo of four independent Node services plus two shared packages
(`@geniusdebug/shared`, `@geniusdebug/db`). Each app is a plain `node dist/main.js` process.

| App | Role | Port | Public? | Build target | Start |
|---|---|---|---|---|---|
| **ingest** | Sentry envelope intake — auth, rate-limit, size-cap, enqueue. The hot path. | `4001` | **Yes** → `ingest.<you>` | `-w @geniusdebug/shared -w @geniusdebug/db -w @geniusdebug/ingest` | `node apps/ingest/dist/main.js` |
| **api** | Dashboard REST API — issues, projects, auth, admin, GitHub. | `4002` | Yes → `api.<you>` | `…-w @geniusdebug/api` | `node apps/api/dist/main.js` |
| **workers** | Queue consumers — normalize → symbolicate → group → persist → alert. Runs retention + partition jobs. | `4003` (health only) | No (background) | `…-w @geniusdebug/workers` | `node apps/workers/dist/main.js` |
| **web** | React SPA dashboard (static bundle). | static | Yes → `app.<you>` | `-w @geniusdebug/web` | serve `apps/web/dist` |

!!! info "Every service now serves a landing + health page"
    Hitting a service root in a browser shows a small status page; API clients get JSON. `ingest`,
    `api`, and `workers` all answer `GET /health` → `{status:"ok"}` — use these for your load
    balancer / platform healthchecks. `workers` listens on `WORKERS_PORT` (default `4003`) **only**
    for this health face; it does no HTTP work otherwise.

**Dependency & start order:** datastores (Postgres, Redis) → `db:migrate` (one-shot) → `ingest`, `api`,
`workers`, `web` (any order). Only `ingest` must be publicly reachable for events to flow; `web` +
`api` are for humans.

### 2.1 Run them with pm2 (bare VPS)

```bash
sudo npm i -g pm2
pm2 start apps/ingest/dist/main.js  --name gd-ingest
pm2 start apps/api/dist/main.js     --name gd-api
pm2 start apps/workers/dist/main.js --name gd-workers
pm2 save && pm2 startup             # restart on reboot
pm2 logs gd-workers                 # the pipeline logs here
```

The `web` app is static — you serve `apps/web/dist` from your reverse proxy (§4.3), not pm2.

---

## 3. Deploy on Coolify

[Coolify](https://coolify.io) runs each service from this repo with **Nixpacks** (no Dockerfile).
Create **four separate Coolify Applications** (one per app) plus Coolify-managed **PostgreSQL** and
**Redis**, all in one Coolify Project so they can share environment variables.

### 3.1 Add the datastores

Coolify → your Project → **+ New** → **Database** → PostgreSQL 16, and again → Redis 7. After they
start, copy each one's **internal** connection URL (see the gotcha below).

### 3.2 Set shared environment variables

On the **Project** → Environment Variables, add the values every backend shares:
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `API_PUBLIC_URL`, `WEB_URL`. Generate
the two secrets with `openssl rand -hex 32`.

### 3.3 Create the four applications

For each, source = this repo, branch = `dev` (or `main`), Build Pack = **Nixpacks**.

=== "ingest"

    - **Build:** `npm ci && npm run build -w @geniusdebug/shared -w @geniusdebug/db -w @geniusdebug/ingest`
    - **Start:** `node apps/ingest/dist/main.js`
    - **Port:** `4001` · **Domain:** `ingest.<you>` (public)

=== "api"

    - **Build:** `npm ci && npm run build -w @geniusdebug/shared -w @geniusdebug/db -w @geniusdebug/api`
    - **Start:** `node apps/api/dist/main.js`
    - **Pre-Deploy:** `npm run db:migrate`  *(runs the schema migration before each deploy; tsx is present because dev deps aren't pruned)*
    - **Port:** `4002` · **Domain:** `api.<you>` (public)

=== "workers"

    - **Build:** `npm ci && npm run build -w @geniusdebug/shared -w @geniusdebug/db -w @geniusdebug/workers`
    - **Start:** `node apps/workers/dist/main.js`
    - **Port:** `4003` · **Domain:** none (background). Healthcheck → `GET /health` on `4003`.

=== "web"

    - Build Pack = **Nixpacks → Static site** (nginx) with **SPA** enabled.
    - **Base Directory:** `/`  ·  **Build:** `npm ci && npm run build -w @geniusdebug/web`
    - **Publish Directory:** `apps/web/dist`
    - **Build variable:** `VITE_API_URL=https://api.<you>` (absolute → the SPA calls the API directly)
    - **Domain:** `app.<you>` (public)

On each of `ingest` / `api` / `workers`, reference the shared vars (see the gotcha) so they inherit
`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `API_PUBLIC_URL`, `WEB_URL`.

### 3.4 Coolify gotchas (learned the hard way)

??? danger "Shared variables don't auto-inject — reference them per app"
    A Project-level variable is **not** automatically visible inside an application. In each app's
    Environment Variables, add a reference row: `KEY={{project.KEY}}` (e.g.
    `DATABASE_URL={{project.DATABASE_URL}}`). Without it the app falls back to localhost and can't reach
    the datastores.

??? danger "Use the INTERNAL datastore URLs, not the external TLS ones"
    Wire `DATABASE_URL` / `REDIS_URL` to Coolify's **internal** URLs. In particular Redis must be the
    internal `redis://…:6379` — the external `rediss://…:6380` (TLS) URL is mis-parsed by ioredis and
    fails with an ENOENT socket error.

??? danger "Set a Start Command — an empty one restart-loops"
    Leaving Start Command blank yields `bash -c: option requires an argument` and the container
    restart-loops. Always set the `node …/dist/main.js` start command.

??? danger "Static web: Base Directory must be `/`"
    For the `web` static app, Base Directory has to be `/` (repo root — npm workspaces need every
    `package.json` + the lockfile). Pointing it at `apps/web` yields "failed to detect app type".
    Do **not** use the repo's `apps/web/Dockerfile` here — its nginx hardcodes an `api:4002` upstream
    that only exists inside the compose network.

??? warning "Background worker still needs a Port field"
    Coolify's create form requires a port even for a background service — `workers` now serves a real
    `/health` on `4003`, so set `4003` and point the healthcheck there.

---

## 4. Deploy on AWS or DigitalOcean

Managed datastores + a VPS (or PaaS) for the Node apps. Pick the split that fits.

### 4.1 DigitalOcean

=== "Droplet + managed DB (recommended)"

    1. **Managed PostgreSQL** and **Managed Redis** from the DO console — same region as the Droplet.
       Copy their connection strings into `DATABASE_URL` / `REDIS_URL`. Add the Droplet to each
       database's **Trusted Sources** so only it can connect.
    2. A **Droplet** (Ubuntu 22.04, 2 vCPU/4 GB). Follow [§1.2–1.5](#1-initial-setup-on-a-dedicated-vps)
       but skip the local Postgres/Redis install — point at the managed URLs instead.
    3. Run the four apps with **pm2** ([§2.1](#21-run-them-with-pm2-bare-vps)); front them with Caddy
       ([§4.3](#43-tls-reverse-proxy)).

=== "App Platform"

    Create **four Components** from this GitHub repo:

    - three **Web Services** — `ingest` (HTTP port 4001), `api` (4002), and a **Worker** component for
      `workers`; build/start commands exactly as in the [Coolify table](#33-create-the-four-applications).
    - one **Static Site** — build `npm ci && npm run build -w @geniusdebug/web`, output dir
      `apps/web/dist`, build-time env `VITE_API_URL=https://api.<you>`.

    Add DO **Managed Postgres + Redis**, bind their URLs as component env vars, and run `db:migrate`
    once as a **pre-deploy Job** on the `api` component.

### 4.2 AWS

- **RDS for PostgreSQL** (16) + **ElastiCache for Redis** (7), in a private subnet.
- **EC2** (t3.small/medium, Ubuntu) in the same VPC — security group allows only the app SG to reach
  RDS:5432 and ElastiCache:6379. Follow [§1](#1-initial-setup-on-a-dedicated-vps) using the RDS/Redis
  endpoints for `DATABASE_URL` / `REDIS_URL`; run the apps with pm2.
- Put **CloudFront / ALB** or Caddy in front for TLS. Point `ingest.<you>`, `api.<you>`, `app.<you>`
  at it. (For blobs and email you'll use R2 + SES anyway — see §6.)

!!! tip "AWS-native storage & email fit naturally"
    You'll likely already have IAM — SES for alert email is a first-class fit, and R2 (or S3, via the
    S3-compatible client) holds source maps + replays. Configure both in §6.

### 4.3 TLS reverse proxy

Any deploy that isn't a managed static host needs a TLS proxy in front of `ingest` and `api`, and a
static file server for the web bundle. Caddy (auto-HTTPS) example:

```
ingest.<you> { reverse_proxy localhost:4001 }
api.<you>    { reverse_proxy localhost:4002 }
app.<you> {
    root * /home/genius/geniusDebug/apps/web/dist
    try_files {path} /index.html      # SPA fallback — required
    file_server
}
```

`try_files … /index.html` (SPA fallback) is mandatory or dashboard deep-links 404 on refresh.

---

## 5. Set up a project and use your existing Sentry SDK

geniusDebug speaks the **Sentry envelope protocol**, so any Sentry SDK works against it **unchanged** —
you only repoint the DSN. Full detail: [Integrate an app](integration.md).

### 5.1 Create a project & copy the DSN

Open `app.<you>` → the first visitor **registers and becomes admin** (this provisions a default
project, DSN, environments, and a default alert rule). Settings → your project shows a **DSN**:

```
https://<publicKey>@ingest.<you>/<projectId>
```

The public key is **write-only** (send-only, cannot read data) — safe in a client bundle. Add more
projects from the **Projects** page; each member sees only the projects an admin grants them.

### 5.2 JavaScript / Next.js (`@sentry/nextjs`)

If your Next.js app already uses `@sentry/nextjs`, change three things:

```ts
// sentry.client.config.ts / server / edge
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,  // = the geniusDebug DSN above
  tunnelRoute: '/monitoring',               // first-party forward, beats ad-blockers
  environment: process.env.NEXT_PUBLIC_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0,
});
```

```js
// next.config.mjs — stop Sentry's SaaS source-map upload; geniusDebug uploads maps itself
export default withSentryConfig(nextConfig, {
  sourcemaps: { disable: true },
  release: { create: false },
  tunnelRoute: '/monitoring',
  // do NOT set org / project / authToken
});
```

Then add the same-origin tunnel route and run geniusDebug's map uploader in CI so frames symbolicate.
A complete drop-in reference (client/server/edge config, instrumentation, global-error, tunnel route,
remote kill switch) lives in **`taskip-integration/`** in the repo.

Upload source maps on each deploy of your app:

```bash
GENIUSDEBUG_API=https://api.<you> \
GENIUSDEBUG_ORG_TOKEN=<secret org token from Settings> \
GENIUSDEBUG_PROJECT_ID=<project id> \
R2_BUCKET=… R2_ENDPOINT=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
RELEASE=$VERCEL_GIT_COMMIT_SHA \
node scripts/upload-sourcemaps.mjs
```

### 5.3 Laravel / PHP (`sentry/sentry-laravel`)

The backend is **platform-agnostic** — PHP events group, get culprits, and render like JS events, and
symbolication is skipped for non-JS (PHP already has real file paths). Install the SDK and point its
DSN at geniusDebug:

```bash
composer require sentry/sentry-laravel
php artisan sentry:publish --dsn=https://<publicKey>@ingest.<you>/<projectId>
```

```bash
# .env (Laravel app)
SENTRY_LARAVEL_DSN=https://<publicKey>@ingest.<you>/<projectId>
SENTRY_TRACES_SAMPLE_RATE=0.1
```

That's the whole integration — no tunnel and no source maps for server platforms. (Laravel is
formally a **v2** target per SRS §12, but the ingest + pipeline already accept `platform:"php"` events
today.)

### 5.4 Any other Sentry SDK

Server-to-server SDKs (`@sentry/node`, Python, Go, Ruby…) need only the DSN:

```ts
Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
```

### 5.5 Verify the loop

Trigger a handled error → it appears in **Issues** within seconds (grouped, with a culprit file) →
open it for the stack, highlights, and trace ID. Once maps are uploaded and a repo is linked, frames
symbolicate and deep-link to the exact GitHub commit + line.

---

## 6. What you must configure after deploy

Do these before treating the deployment as production.

### Must-do

- [ ] **Rotate any secrets pasted during setup.** If a DB/Redis password was ever pasted into a chat,
      ticket, or shell history, rotate it now.
- [ ] **`APP_ENCRYPTION_KEY` is set** (32-byte hex, same value across `api` + `workers`). It encrypts
      GitHub App + integration secrets at rest. Without it, the code falls back to a dev key **and logs
      a warning** — fine for local, not for prod. Changing it later makes existing encrypted secrets
      unreadable, so set it once, up front.
- [ ] **`API_PUBLIC_URL` + `WEB_URL` are the real HTTPS hosts.** GitHub App manifest callbacks and
      dashboard redirects depend on them being browser-reachable.
- [ ] **`ingest.<you>` is publicly reachable over HTTPS** — the SDK / tunnel posts here.
- [ ] **TLS + SPA fallback** on the `web` host (`try_files … /index.html`).
- [ ] **First admin created** — register at `app.<you>` immediately so nobody else claims the org.

### Connect the optional services (Settings → Integrations)

The core capture → group → triage loop works without these; each one lights up a feature. Prefer the
in-app **Settings → Integrations** tab (credentials are encrypted in the DB) over env vars — though env
vars win when both are set.

- [ ] **Cloudflare R2 (or S3)** — required for **source-map symbolication** and **replay playback**
      (blobs live in R2; Postgres stores only pointers). Set bucket + endpoint + keys, then **Test**.
- [ ] **AWS SES** — required for **email**: alert notifications and member-invite emails. Until it's
      connected, alerts still fire and dedupe (send is a logged no-op), and invites fall back to a
      copyable link the admin shares manually. Verify a sender domain and leave the SES sandbox.
- [ ] **GitHub App** — Settings → GitHub → **Create GitHub App** (manifest flow, personal or org).
      Enables per-frame "Open in GitHub", suspect commits, and auto-resolve on `fixes SHORT-ID`. The
      callback uses `API_PUBLIC_URL`, so that must be correct first.

### Operations & safety

- [ ] **Kill switch** — Settings → Remote config → **Disable ingest** drops events cheaply (202) with
      no redeploy. Know where it is before you need it.
- [ ] **Retention windows** — defaults: events 30d, replays 14d, source maps 90d
      (`RETENTION_*_DAYS`). The `workers` service runs a daily purge (events/replays/maps + R2 blobs)
      and rolls monthly `events` partitions forward. Tune to your storage budget.
- [ ] **Backups** — `pg_dump` (or managed PITR) for Postgres; R2 lifecycle rules aligned to the
      retention windows for blobs.
- [ ] **Metrics** — Settings → **System metrics** (queue depth, p50/p95 latency, dropped-event
      counters) to watch pipeline health.
- [ ] **Grant project access** — new members start with **zero** projects; an admin grants each via
      Settings → Members → Project access.

### Post-deploy checklist (copy/paste)

- [ ] `DATABASE_URL` / `REDIS_URL` point at geniusDebug's **own** infra (not the monitored app's)
- [ ] `JWT_SECRET` + `APP_ENCRYPTION_KEY` set, strong, identical across `api` + `workers`
- [ ] migrations applied (`db:migrate` ran clean)
- [ ] `ingest` / `api` / `web` all reachable over HTTPS; `workers` `/health` green
- [ ] first admin registered; SDK DSN repointed; a test error landed in Issues
- [ ] R2 + SES + GitHub App connected (or consciously deferred)
- [ ] backups + retention configured
