# geniusDebug

A minimal, self-hosted **Sentry alternative** for capturing and triaging **frontend errors** from the Taskip Next.js app — stack traces, source-mapped locations, distributed traces, and short session replays — without Sentry's cost/overkill.

We **reuse the open-source Sentry SDK** (`@sentry/nextjs`) pointed at our own backend; the backend speaks the Sentry **envelope protocol**.

## Docs
- **`docs/geniusDebug-SRS.md`** — the full software requirements spec (v1.5, the build spec).
- **`docs/frontend-design-brief.md`** — the UI/design spec: tokens, global shell, every page, component states, mapped to SRS requirement IDs.
- **`CLAUDE.md`** — project guide + golden rules for anyone (incl. Claude) working in this repo.

## Stack
NestJS · PostgreSQL (Drizzle ORM) · Redis (BullMQ) · Cloudflare R2 · AWS SES · React + Zustand + Tailwind · `@sentry/nextjs`.

## Status
v1 = Next.js frontend monitoring. Laravel/PHP support is planned for **v2** (SRS §12).

## Monorepo layout
```
apps/ingest    NestJS — Sentry envelope endpoint (the cheap hot path)
apps/workers   BullMQ consumers — normalize → symbolicate → fingerprint → group → persist → alert
apps/api       NestJS REST — auth (login/register), issues, actions, projects, traces, replays, alerts
apps/web       React + Vite + Tailwind + Zustand + TanStack Query — the dashboard
packages/db    Drizzle schema + migrations (events is time-partitioned)
packages/shared  Sentry envelope + domain types, zod boundary schemas
scripts/upload-sourcemaps.mjs  deploy-time Debug-ID → R2 uploader (§4.3)
```

## Getting started (local, npm workspaces)
Prereqs: Node ≥ 20, PostgreSQL, Redis.

```bash
npm install
createdb geniusdebug_dev
cp .env.example .env                    # never commit .env
npm run build -w @geniusdebug/shared    # build shared + db so apps resolve them
npm run build -w @geniusdebug/db
npm run migrate -w @geniusdebug/db      # creates schema + partitions events

# start the four services (or run each in its own terminal)
npm run dev            # api :4002 · ingest :4001 · workers · web :5173

# open http://localhost:5173 → first run shows "Create your account" (you become admin);
# registering provisions a default Taskip project + DSN + environments + alert rule.

# fire the SRS §1.5 reference incident through the real ingest → worker pipeline:
npm run seed -w @geniusdebug/db         # POSTs a Sentry envelope to ingest; issue appears in the feed
```

Golden rules and architecture live in `CLAUDE.md`; the authoritative behavior spec is `docs/geniusDebug-SRS.md`. Copy `.env.example` → `.env` and fill in R2 / SES / DB / GitHub App credentials (never commit `.env`).
