# Configuration

All configuration is environment variables. Copy `.env.example` → `.env` and fill it in. **Secrets are
server-side only** — never in the web bundle, never committed. The only public value is the write-only
DSN public key.

!!! tip "Docker vs bare-metal"
    In the [Docker stack](self-hosting-docker.md), `DATABASE_URL` and `REDIS_URL` are **overridden** by
    compose (network hostnames `postgres` / `redis`) — you only set `POSTGRES_PASSWORD`. For a
    bare-metal deploy you set `DATABASE_URL` / `REDIS_URL` yourself.

## Core (required)

| Variable | Example | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/geniusdebug` | geniusDebug's **own** Postgres (NFR-PERF-5). |
| `REDIS_URL` | `redis://:pass@host:6379` | queue + rate limits + map cache. |
| `JWT_SECRET` | `openssl rand -hex 32` | dashboard auth signing key. |
| `JWT_EXPIRES_IN` | `7d` | token lifetime. |
| `APP_ENCRYPTION_KEY` | 32-byte hex (`openssl rand -hex 32`) | encrypts GitHub App / integration secrets at rest (NFR-SEC-5). Set in prod — dev falls back with a warning. |

## Docker stack only

| Variable | Example | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | strong password | password for the bundled Postgres (user `genius`, db `geniusdebug`). Compose builds `DATABASE_URL` from it. |

## Ports & URLs

| Variable | Default | Notes |
|---|---|---|
| `INGEST_PORT` | `4001` | envelope endpoint. |
| `API_PORT` | `4002` | dashboard API. |
| `WEB_PORT` | `5199` | dev server only (`npm run dev`). |
| `API_PUBLIC_URL` | `https://api.<you>` | used in GitHub App manifest redirect/callback URLs — must be browser-reachable. |
| `WEB_URL` | `https://app.<you>` | dashboard origin for post-callback redirects. |
| `VITE_API_URL` | `/api` (Docker) · `https://api.<you>` (split origin) | **build-time**, public. The Docker `web` image defaults to `/api` and nginx proxies it. |

## Ingest limits (FR-ING-2/4)

| Variable | Default | Notes |
|---|---|---|
| `INGEST_RATE_LIMIT_PER_MIN` | `3000` | per-project token bucket. |
| `MAX_EVENT_ITEM_BYTES` | `1048576` (1 MiB) | per envelope item cap → 413. |
| `MAX_ENVELOPE_BYTES` | `209715200` (200 MiB) | whole-envelope cap. |
| `QUEUE_SHED_THRESHOLD` | `5000` | waiting-job depth above which low-value items (traces/replay) are shed (FR-WRK-4). |

## Cloudflare R2 — blobs (optional)

Source maps + replay recordings. Without it the **core error loop still works**; symbolication and
replay playback need it.

| Variable | Notes |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account id. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token. |
| `R2_BUCKET` | e.g. `geniusdebug-blobs`. |
| `R2_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com`. |

## AWS SES — email alerts (optional)

Without it, alert rules still fire and dedupe/throttle — the send is a no-op (logged in dev).

| Variable | Notes |
|---|---|
| `SES_REGION` | e.g. `us-east-1`. |
| `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` | SES credentials. |
| `SES_FROM` | verified sender, e.g. `alerts@<you>`. |

!!! note "Prefer the in-app Integrations tab"
    R2 and SES can also be connected from **Settings → Integrations** (encrypted in the DB). Env vars
    win when both are set (ops override); the DB row is used when the env var is unset.

## GitHub App — source links (optional)

| Variable | Notes |
|---|---|
| `GITHUB_APP_ID` | numeric App id. |
| `GITHUB_APP_PRIVATE_KEY` | PEM private key. |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | OAuth credentials. |

Most teams create the App from **Settings → GitHub → Create GitHub App** (manifest flow) rather than
setting these by hand.

## Retention windows (days) — FR-RET-1

| Variable | Default |
|---|---|
| `RETENTION_EVENT_DAYS` | `30` |
| `RETENTION_REPLAY_DAYS` | `14` |
| `RETENTION_MAP_DAYS` | `90` |

The `workers` service runs a daily purge that drops aged partitions/events, replays, and maps (also
removing the R2 blobs).
