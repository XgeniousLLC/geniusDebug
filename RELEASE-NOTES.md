# geniusDebug v1.0.0

**A minimal, self-hosted Sentry alternative for frontend error monitoring.** Capture, group, and
triage runtime errors from your Next.js / React app — stack traces, source-mapped code locations,
distributed traces, and short session replays — on your own infrastructure, no per-event pricing.

Reuses the standard `@sentry/nextjs` SDK: point your DSN at geniusDebug and go. MIT licensed.

## Highlights

- **Error grouping** into deduplicated Issues — fingerprinting, short IDs, regression detection.
- **Symbolication** — Debug-ID source maps (R2) → original file / line / function + source context.
- **GitHub App** — manifest install (personal or org), per-frame "Open in GitHub", suspect commits,
  auto-resolve on `fixes SHORT-ID`.
- **Distributed traces** — span waterfall with error markers, linked back to issues.
- **Session replay** — on-error, privacy-masked, error-marked timeline.
- **Alerts** — new / regression / frequency (spike) rules with dedupe, throttle, snooze; AWS SES email.
- **Triage UX** — filters, sort, global search (⌘K), keyboard nav, merge, assign, editable highlights.
- **Admin** — multi-project, DSN key regenerate/revoke, members + roles, per-project access control,
  retention windows, usage stats, internal metrics.
- **Safety** — remote kill switch (disable ingest without a redeploy), back-pressure shedding,
  dead-letter queue.
- **Scale** — time-partitioned events with auto-rolled monthly partitions + retention purge.

## Deploy

- **Docker Compose** — `docker compose up -d --build` brings up Postgres, Redis, migrate, and all four
  services.
- **Coolify** (Nixpacks) or a **plain VPS** (pm2) — per-service.
- **AWS / DigitalOcean** — managed Postgres + Redis + a VPS / App Platform.

Full walkthrough: <https://xgeniousllc.github.io/geniusDebug/deployment-guide.html>

## Requirements

Docker 24+ & Compose v2 — or Node 20 LTS + PostgreSQL 16 + Redis 7. Optional: Cloudflare R2 (source
maps + replays), AWS SES (email alerts), a GitHub App (source deep-links). ~2 GB RAM / 2 vCPU for a
small team.

## Integrate an app

Already using `@sentry/nextjs`? Repoint the DSN, add a tunnel route, disable Sentry's SaaS source-map
upload, and run geniusDebug's uploader in CI. Any Sentry SDK works unchanged (Laravel/PHP included —
the pipeline is platform-agnostic). See <https://xgeniousllc.github.io/geniusDebug/integration.html>.

## Install

```bash
git clone https://github.com/XgeniousLLC/geniusDebug.git
cd geniusDebug
cp .env.example .env          # set JWT_SECRET, APP_ENCRYPTION_KEY, POSTGRES_PASSWORD
docker compose up -d --build
# open http://localhost:8080 → create your admin account
```

Or download the source zip attached to this release.

---

**Docs:** <https://xgeniousllc.github.io/geniusDebug/> · **License:** MIT © 2026 Xgenious LLC
