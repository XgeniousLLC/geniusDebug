# geniusDebug — Project Guide (CLAUDE.md)

> Read this first. It defines what geniusDebug is, how it's built, and the non-negotiable rules for changing it. The authoritative spec is **`docs/geniusDebug-SRS.md`** (v1.5). The UI spec is **`docs/frontend-design-brief.md`**.

## What this is
geniusDebug is a **minimal, self-hosted Sentry alternative** for capturing, grouping, and triaging **frontend runtime errors** from the Taskip Next.js app — with stack traces, source-mapped code locations, distributed traces, and short session replays. It exists because Sentry is overkill and expensive for our real usage. We **reuse the open-source Sentry SDKs** (`@sentry/nextjs` in v1) pointed at our own backend; we do **not** build a browser SDK.

## Architecture (four parts)
1. **Client** — stock `@sentry/nextjs` in Taskip, sending Sentry **envelopes** (custom DSN + `tunnelRoute`).
2. **Ingest** — thin NestJS endpoint speaking the **Sentry envelope protocol** (`POST /api/{projectId}/envelope/`); authenticate → rate-limit → enqueue → `202`. Does **no** heavy work.
3. **Workers** — NestJS consumers of the Redis (BullMQ) queue: parse items, symbolicate, group, persist, alert.
4. **Dashboard + API** — NestJS REST/GraphQL API + React SPA for triage.

## Tech stack (mandated)
- Backend & workers: **NestJS + TypeScript**
- DB: **PostgreSQL** via **Drizzle ORM** (`drizzle-kit` migrations)
- Queue/cache/rate-limits: **Redis** (BullMQ)
- Blobs (replay, source maps): **Cloudflare R2** (S3-compatible)
- Email: **AWS SES**
- Dashboard: **React + Zustand + Tailwind + TypeScript**
- Client SDK: **`@sentry/nextjs`** (v1). Laravel `sentry/sentry-laravel` is **v2** (§12 of SRS).

## Suggested monorepo layout
```
apps/
  ingest/        # NestJS — envelope endpoint only (hot path)
  workers/       # NestJS — queue consumers (pipeline)
  api/           # NestJS — dashboard REST/GraphQL
  web/           # React SPA (Zustand + Tailwind)
packages/
  db/            # Drizzle schema + client + migrations (shared)
  shared/        # shared TS types (event schema, DTOs)
scripts/
  upload-sourcemaps.mjs   # deploy-time: Debug IDs → R2 → register release
docs/
  geniusDebug-SRS.md
  frontend-design-brief.md
```

---

## GOLDEN RULES (non-negotiable)

1. **Never affect Taskip's performance or behavior.** This is the whole reason the product exists. The SDK path is async and best-effort; if geniusDebug is slow or down, Taskip is unaffected. Nothing we do may block the user's request/render. (SRS §6.1)
2. **The ingest hot path stays cheap.** Ingest only authenticates, rate-limits, shallow-validates, and enqueues. **No** symbolication, grouping, DB writes, or blob buffering inline. Target p95 < 25 ms. Heavy work happens in workers. (FR-ING-3)
3. **The Sentry envelope format is a pinned contract.** Pin the `@sentry/nextjs` major version. Treat the envelope payload as an external interface — an SDK upgrade is a **reviewed change**. (FR-SDK-10)
4. **Keep the pipeline platform-agnostic.** Key processing off the event `platform` field; never hardcode JavaScript assumptions. Symbolication is skipped when `platform !== javascript`. This is what makes Laravel (v2) a small add. (FR-WRK-7, FR-MAP-10)
5. **Secrets are server-side only.** R2, SES, DB, GitHub App keys, and the secret org upload token live in env/secret manager — never in the client bundle, never committed. The public DSN key is write-only and cannot read data. Do **not** edit `.env` files (a hook blocks it); edit `.env.example`.
6. **Cost discipline is a feature.** Sampling, quotas/rate-limits, retention purges, and storing full detail only for sample events per issue are requirements, not nice-to-haves. (FR-RET-*, FR-ING-2)
7. **Reference the spec.** When implementing or reviewing, cite the SRS requirement IDs (FR-*/NFR-*) you satisfy. Use the `verify-against-srs` skill.

---

## Coding conventions
- **TypeScript strict** everywhere. No `any` in shared/domain code; parse/validate at boundaries (ingest input, API DTOs).
- **NestJS**: feature modules; thin controllers, logic in services/providers; inject dependencies (don't import singletons where DI fits). Validate DTOs.
- **Errors**: never swallow silently in workers except where the spec requires graceful degradation (e.g. missing source map → raw frame + warning, FR-MAP-8). Poison messages → dead-letter queue, never block the pipeline (FR-WRK-1).
- **Idempotency**: worker processing is idempotent on `event_id` (at-least-once delivery must not double-count `times_seen`). (FR-WRK-2)
- **Naming**: requirement-traceable where useful (e.g. comment `// FR-GRP-1` near the fingerprint logic).

## Database (Drizzle) — read the `drizzle-change` skill
- Schema is the single source of truth in `packages/db/schema.ts`. Change schema there, then `drizzle-kit generate` → review the SQL → `drizzle-kit migrate`.
- **`events` is time-partitioned** — Drizzle emits the base table; the `PARTITION BY RANGE (timestamp)` + partitions are **hand-authored** in a migration. Don't lose this when regenerating.
- Blobs live in **R2**; Postgres stores metadata + `r2Key` pointers only.
- Index for the real queries: issue list `(project_id, status, last_seen)`, symbolication lookup `(project_id, debug_id)`, events `(issue_id, timestamp)`.

## Ingest & workers
- Ingest: gunzip, shallow-validate envelope framing, enforce size caps (≤1 MiB/event item, ≤200 MiB/envelope), stream oversized `replay_recording`/`attachment` items to R2, enqueue a pointer.
- Workers pipeline order: normalize → symbolicate (JS only) → fingerprint → upsert issue (+regression detect) → persist → evaluate alerts.
- Implement item types in phases: **`event` → `transaction` → replay**. Don't block the MVP on replay.

## Frontend
- Build to **`docs/frontend-design-brief.md`** — it defines the design tokens, global shell, every page, and component states. Match it exactly.
- **Zustand** for client state; keep server data in a query layer (e.g. TanStack Query) — don't dump everything in Zustand.
- **Tailwind** with the design tokens from the brief (don't hardcode hex values; use the token scale). Support light + dark.
- Monospace for code, stack frames, IDs (event/trace/debug IDs).

## Verification
- Non-trivial changes get a verification step: unit tests for fingerprinting/grouping/symbolication; a smoke test that a real Sentry envelope round-trips ingest → worker → issue.
- For the reference incident (`TypeError: Cannot read properties of undefined (reading 'json')` → `useInboxConversations.ts`), the acceptance path in SRS §9 must work end to end.

## Git
- Branch off the default branch; don't commit to it directly.
- Reference SRS IDs in commit messages where relevant (e.g. `feat(ingest): envelope parsing FR-ING-1/FR-WRK-5`).
- Never commit secrets or `.env`.

## When unsure
- Prefer the SRS. If the SRS is silent or ambiguous, ask rather than guess on anything touching the golden rules (performance isolation, the envelope contract, secrets, cost).

---

# Task Tracker

## Project Prefix: GD

## Sprint 1 — MVP: ingest → worker → issue → dashboard, with login/register
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-001 | Monorepo scaffold (pnpm + TS strict) | DONE | HIGH | apps/{ingest,workers,api,web} + packages/{db,shared}, health endpoints |
| GD-002 | DB package (Drizzle schema + migrations) | DONE | HIGH | SRS §7 full model, indexes, events partitioning |
| GD-003 | Shared types (envelope + domain + zod) | DONE | HIGH | Sentry envelope items + internal DTOs, platform-agnostic |
| GD-004 | Ingest service (envelope hot path) | DONE | HIGH | FR-ING-1..7: DSN auth, rate limit, size caps, enqueue |
| GD-005 | Workers pipeline (event grouping) | DONE | HIGH | FR-WRK/FR-GRP: normalize→fingerprint→upsert issue→persist, idempotent, DLQ |
| GD-006 | Dashboard API + auth (login/register) | DONE | HIGH | FR-UI/FR-ADM: JWT auth, register first-user+org, issues API, actions |
| GD-007 | Web design system + shell | DONE | HIGH | brief §2/§3/§4 tokens, components, sidebar, env selector, brand |
| GD-008 | Login/Register page (first-time login) | DONE | HIGH | brief §5: login + first-time register with org creation |
| GD-009 | Issues feed | DONE | HIGH | brief §7 / FR-UI-1..4: filter, sort, triage actions |
| GD-010 | Issue detail + highlights + stack trace | DONE | HIGH | brief §8 / FR-UI-5/6: highlights, stacktrace, breadcrumbs, tags, activity |
| GD-011 | Symbolication (Debug-ID basic) | DONE | MED | FR-MAP: skip non-JS, source context, GitHub deep-link |
| GD-012 | Traces waterfall page | DONE | MED | brief §9 / FR-TRC: transaction ingest + span waterfall |
| GD-013 | Replays page/player | DONE | MED | brief §10 / FR-RPL: on-error replay metadata + player shell |
| GD-014 | Alerts pages + throttle | DONE | MED | brief §11 / FR-ALR: rules, dedupe/throttle, notification history |
| GD-015 | Settings (DSN/GitHub/retention/kill switch) | DONE | MED | brief §12 / FR-ADM/FR-GH/FR-RET/FR-SDK-8 |
| GD-016 | Seed reference incident + browser verify | DONE | HIGH | SRS §9 acceptance path end-to-end, Chrome cross-verify |

### Sprint Stats
- Total: 16  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 16  /  BLOCKED: 0
- Tokens: ~205k total (single build session)

### Verification notes (Sprint 1)
Browser-verified end-to-end (Chrome, light + dark):
- First-time register → admin + auto-provisioned Taskip project/DSN/envs/alert-rule.
- Reference incident (SRS §1.5) through **real ingest → BullMQ → worker → issue**: grouped
  `JAVASCRIPT-NEXTJS-1`, culprit `./stores/inbox/useInboxConversations.ts`, symbolicated in-app
  frame w/ source context (line 42), Highlights (handled/level/transaction/url/Trace ID).
- Triage actions (resolve/archive/mute) + activity trail; **regression** re-open (resolved→unresolved,
  is_regressed, times_seen bump); idempotency on event_id.
- Alerts: default rule + dedupe/throttle notification ledger (new + regression each sent once).
- Ingest hot path: 202 fast-path, DSN auth (403), rate-limit (429), size caps (413), gunzip.
- events table is range-partitioned; unit tests pass for fingerprint/grouping.

Wired but need live data / prod creds to be fully exercised (not blockers for v1 MVP):
- **Symbolication (FR-MAP-3/4):** Debug-ID → source_map_artifacts lookup + GitHub deep-link builder
  are wired; applying real maps needs the deploy uploader (`scripts/upload-sourcemaps.mjs`) + R2 creds.
- **Traces (FR-TRC):** worker stores traces/spans and the waterfall page renders — needs `transaction`
  envelope items to populate.
- **Replays (FR-RPL):** on-error metadata path + list/player shell — needs `replay_recording` items + R2.
- **SES send (FR-ALR-6):** throttle/ledger real; actual SendEmail is stubbed (logged) pending SES creds.
- **GitHub App (FR-GH-1):** repo-link model + frame deep-link builder present; OAuth install flow pending.

## Sprint 2 — Close local acceptance gaps: trace waterfall + GitHub deep-links
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-017 | Transaction ingest → live Trace waterfall | DONE | HIGH | FR-TRC-1..4: send `transaction` envelope, worker stores trace+spans, waterfall renders + links back to issue |
| GD-018 | GitHub repo link + frame "Open in GitHub" | DONE | HIGH | FR-GH-1/3, FR-MAP-6: link repo (admin API), stamp release commit, in-app frames deep-link to exact line |
| GD-019 | Releases artifact-registration endpoint | DONE | MED | FR-BLD-2 / §4.3 API: secret org-token auth, register Debug-ID/R2-key/commit index |

### Sprint Stats
- Total: 3  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 3  /  BLOCKED: 0
- Tokens: ~60k total

## Sprint 3 — Safety, retention, members, replay; wire creds-blocked paths
**Status:** LOCAL COMPLETE (3 BLOCKED on creds)
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-020 | Kill switch toggle UI + verify | DONE | HIGH | FR-SDK-8/NFR-PERF-4: toggle project.ingestEnabled; ingest drops with 202 disabled |
| GD-021 | Retention purge job (events/replays/maps) | DONE | HIGH | FR-RET-1: scheduled purge of aged events/replays/source maps + R2 |
| GD-022 | Member management (invite/list/role/remove) | DONE | MED | FR-ADM-6: admin-gated members UI + API |
| GD-023 | Replay player shell + seeded replay | DONE | MED | FR-RPL-3/5/6: replay metadata + player timeline, masked blocks |
| GD-024 | Real source-map application (R2) | BLOCKED | MED | FR-MAP-3/4: fetch map from R2, apply, source context — needs R2 creds |
| GD-025 | SES email send | BLOCKED | MED | FR-ALR-6: AWS SES SendEmail templated alert — needs SES creds |
| GD-026 | GitHub App OAuth install flow | BLOCKED | LOW | FR-GH-1: App install → callback → repo pick — needs GitHub App creds |

### Sprint Stats
- Total: 7  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 4  /  BLOCKED: 3
- Tokens: ~70k total

### Verification notes (Sprint 3)
Browser + CLI verified: kill switch (disable → ingest drops event, count unchanged, 202),
member invite/list (admin+member, remove), replay ingest → player (masked input, error-marker
timeline, meta), retention purge job runs.
Creds-blocked (code wired, need secrets in `.env` to exercise — never paste secrets in chat):
- GD-024 R2: `r2.ts` getObject/deleteObjects wired + used by retention; **applying** maps in
  `symbolicate.ts` still TODO (needs R2_* + a real .map).
- GD-025 SES: `ses.ts` SendEmail wired into alerts; activates when SES_* set (dev logs).
- GD-026 GitHub App OAuth install: NOT built — manual repo-link (Settings) works today; OAuth
  install→callback→repo-pick still needs GITHUB_APP_* creds.
