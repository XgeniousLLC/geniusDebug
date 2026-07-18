# Architecture

geniusDebug is **four Node services** plus **PostgreSQL** and **Redis**. It runs on its **own
infrastructure** — never share a database, Redis, or compute with the app you're monitoring
(NFR-PERF-5). If geniusDebug is slow or down, the monitored app is unaffected.

```
  Monitored app + @sentry/nextjs ──envelope(tunnel)──▶ Ingest (NestJS)  ──enqueue──▶ Redis (BullMQ)
                                                       fast 202, no heavy work            │
                                                                                          ▼
   React SPA ◀──REST──▶ API (NestJS) ◀──read── PostgreSQL ◀──persist── Workers (NestJS pipeline)
   (dashboard)                                 (metadata)   normalize→symbolicate→group→persist→alert
                                                   ▲                              │
                                             Cloudflare R2 (blobs) ◀── replay/maps │ SES (email alerts)
```

## The four services

| Part | Package | Role | HTTP |
|---|---|---|---|
| **Ingest** | `apps/ingest` | Sentry envelope endpoint — DSN auth, rate-limit, size caps, enqueue. p95 < 25 ms, **no** heavy work. | `:4001` |
| **Workers** | `apps/workers` | Queue consumers — normalize → symbolicate → fingerprint → group → persist → alert. Idempotent, dead-letter queue. | none |
| **API** | `apps/api` | Auth (login/register), issues, actions, projects, traces, replays, alerts, GitHub App, metrics. | `:4002` |
| **Web** | `apps/web` | React + Vite + Tailwind + Zustand + TanStack Query dashboard (static bundle). | `:80` (nginx) |

Shared packages: `packages/db` (Drizzle schema + migrations; `events` is time-partitioned) and
`packages/shared` (Sentry envelope + domain types, zod schemas — platform-agnostic).

## Why the split matters

- **The ingest hot path stays cheap.** It only authenticates, rate-limits, shallow-validates, and
  enqueues. Everything expensive (symbolication, grouping, DB writes, blob buffering) happens in the
  workers. This is what keeps p95 low and the monitored app safe.
- **Workers scale independently.** They are a pure BullMQ consumer with a dead-letter queue and
  back-pressure shedding — a burst of events never blocks ingest or the dashboard.
- **The web SPA is static.** It is served by nginx and can also sit on any static host / CDN. In the
  Docker stack, nginx also reverse-proxies `/api` → the API service, so the dashboard is same-origin
  (no CORS, no build-time host baked in).

## Data & blobs

- **PostgreSQL** holds all metadata; `events` is range-partitioned by month with auto-rolled
  partitions and a retention purge.
- **Cloudflare R2** (S3-compatible) holds blobs: session-replay recordings and source maps. Postgres
  stores only `r2Key` pointers. R2 is optional — without it, the core error loop still works; replay
  playback and symbolication are the parts that need it.

Do you have to deploy all four? **Yes** — `ingest`, `api`, and `workers` are long-running Node
processes and cannot run on a static host like GitHub Pages; only `web` is static. The
[Docker stack](self-hosting-docker.md) wires all four plus Postgres and Redis together in one command.
