# Self-host with Docker

The fastest way to run the whole geniusDebug stack — `ingest`, `api`, `workers`, `web`, plus
**PostgreSQL** and **Redis** — is `docker compose`. One command builds every service, provisions the
datastores, runs migrations, and starts the dashboard.

!!! info "What you get"
    Six containers on one network: `postgres`, `redis`, a one-shot `migrate`, then `ingest`, `api`,
    `workers`, and `web` (nginx). The dashboard is same-origin — nginx reverse-proxies `/api` to the
    API service, so there is no CORS and no build-time API host to bake in.

## Prerequisites

- **Docker** 24+ and the **Docker Compose v2** plugin (`docker compose`, not the old `docker-compose`).
- ~2 GB free disk for images + volumes.
- That's it — Node, Postgres, and Redis all run inside containers.

## 1. Clone and configure

```bash
git clone https://github.com/XgeniousLLC/geniusDebug.git
cd geniusDebug
cp .env.example .env
```

Open `.env` and set, at minimum:

```bash
JWT_SECRET=<64 random hex>            # openssl rand -hex 32
APP_ENCRYPTION_KEY=<64 random hex>    # openssl rand -hex 32  (encrypts GitHub App secrets at rest)
POSTGRES_PASSWORD=<a strong password> # password for the bundled Postgres (user: genius, db: geniusdebug)
```

Generate the secrets:

```bash
openssl rand -hex 32   # run twice — once for JWT_SECRET, once for APP_ENCRYPTION_KEY
```

!!! note "DATABASE_URL / REDIS_URL are handled for you"
    Compose **overrides** `DATABASE_URL` and `REDIS_URL` with its own network hostnames
    (`postgres` / `redis`), so you don't touch them for the Docker stack — those lines in `.env` only
    matter for a bare-metal `npm run dev`. Only `POSTGRES_PASSWORD` feeds the bundled Postgres.

R2, SES, and GitHub App credentials are **optional** — leave them blank to start. The core
capture → group → triage loop works without them; they light up replay playback, source-map
symbolication, email alerts, and GitHub deep-links respectively. See [Configuration](configuration.md).

## 2. Bring the stack up

```bash
docker compose up -d --build
```

First run builds the images (a few minutes) and, in order:

1. starts `postgres` + `redis` and waits for both to be healthy,
2. runs the one-shot **`migrate`** service (schema + partitioned `events` table + partitions),
3. starts `ingest`, `api`, `workers`, and `web`.

Watch it come up:

```bash
docker compose ps
docker compose logs -f api workers ingest
```

## 3. Open the dashboard

| Service | URL | Notes |
|---|---|---|
| **Dashboard (web)** | <http://localhost:8080> | first visit → "Create your account" (you become admin) |
| **Ingest** | <http://localhost:4001> | the Sentry DSN endpoint your app / SDK posts to |
| **API** | <http://localhost:4002> | also reachable through the dashboard at `/api` |

Registering the first user provisions a default project + DSN + environments + a default alert rule.
The **DSN** shown in Settings is what you point your app at — see [Integrate an app](integration.md).

## 4. Verify end to end (optional)

Fire the reference incident through the real pipeline (ingest → BullMQ → worker → issue):

```bash
docker compose exec workers npm run seed -w @geniusdebug/db
```

Then reload **Issues** — you should see a grouped `TypeError` with a culprit file. Run the automated
suite the same way:

```bash
docker compose exec workers npm test
```

## Ports & what's exposed

| Container | Host port | Purpose | Expose publicly? |
|---|---|---|---|
| `web` (nginx) | `8080 → 80` | dashboard SPA + `/api` proxy | yes (behind TLS) |
| `ingest` | `4001` | envelope endpoint (high-traffic) | **yes** — your app posts here |
| `api` | `4002` | dashboard REST API | optional — the SPA reaches it via nginx `/api` |
| `postgres` | not published | database | no |
| `redis` | not published | queue / cache | no |

For production, put a TLS reverse proxy (Caddy, nginx, Traefik, or your platform's ingress) in front
of `web` (`8080`) and `ingest` (`4001`), and set `API_PUBLIC_URL` / `WEB_URL` in `.env` to the real
HTTPS hosts (GitHub App callbacks depend on them).

## Common operations

**Update to a new version**

```bash
git pull
docker compose up -d --build          # migrate re-runs; migrations are idempotent
```

**Apply migrations manually** (e.g. after a schema change)

```bash
docker compose run --rm migrate
```

**Tail logs / follow one service**

```bash
docker compose logs -f workers
```

**Run the retention purge on demand** (workers also run it daily)

```bash
docker compose exec workers npm run purge -w @geniusdebug/workers
```

**Stop / start / reset**

```bash
docker compose down                   # stop, keep data
docker compose down -v                # stop and DELETE the postgres + redis volumes (data loss)
```

## Data & backups

Two named volumes hold all state:

- `pgdata` → PostgreSQL (issues, events, projects, members, everything).
- `redisdata` → Redis (queue + append-only file).

Back up Postgres with `pg_dump`:

```bash
docker compose exec postgres pg_dump -U genius geniusdebug > geniusdebug-$(date +%F).sql
```

Blobs (replay recordings, source maps) live in **Cloudflare R2**, not in these volumes — back them up
with R2 lifecycle rules aligned to your retention windows.

## Customizing the Compose stack

- **Change host ports** — edit the `ports:` mappings in `docker-compose.yml` (e.g. `"80:80"` for web
  behind your own proxy, or drop the `ingest` publish if you terminate TLS elsewhere).
- **Split origins** — if you serve the dashboard and API on different hosts, rebuild `web` with
  `--build-arg VITE_API_URL=https://api.<you>` and enable CORS on the API instead of the nginx proxy.
- **External Postgres/Redis** — delete the `postgres`/`redis` services and point `DATABASE_URL` /
  `REDIS_URL` (in the `x-backend-env` block) at your managed instances.
- **Per-service images only** — each app has its own `Dockerfile` (`apps/<svc>/Dockerfile`, build
  context = repo root), so you can build and run them under Kubernetes, Nomad, or Coolify without the
  bundled compose file.

## Troubleshooting

??? question "`migrate` exits with a connection error"
    Postgres wasn't healthy yet, or `POSTGRES_PASSWORD` in `.env` doesn't match. Compose waits on a
    healthcheck, but if you changed the password after first boot, reset the volume:
    `docker compose down -v && docker compose up -d --build`.

??? question "Dashboard loads but every request 404s / CORS errors"
    The `web` image bakes `VITE_API_URL=/api` and nginx proxies it to `api:4002`. If you rebuilt `web`
    with a different `VITE_API_URL`, make sure that host is reachable from the browser and CORS is
    enabled on the API.

??? question "Events post to ingest but no issues appear"
    Check `docker compose logs -f workers` — the pipeline runs there. Confirm `migrate` completed and
    Redis is healthy (`docker compose ps`). A poison event is dead-lettered, never blocks the queue.

??? question "I don't have R2 / SES / a GitHub App yet"
    Fine — leave those env vars blank. Capture, grouping, and triage work without them. Replay
    playback, source-map symbolication, email alerts, and GitHub deep-links activate once you add the
    matching credentials (see [Configuration](configuration.md)).
