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

## Sprint 4 — Source-map application engine (creds-free part of GD-024)
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-027 | Source-map application + unit test | DONE | MED | FR-MAP-3/4: resolve minified frame→original via `source-map`; source context; unit-tested with a fixture map (R2 fetch already wired, GD-024) |

### Sprint Stats
- Total: 1  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 1  /  BLOCKED: 0
- Tokens: ~35k total

## Sprint 5 — Complete build: GitHub App OAuth, real R2 uploader, Taskip client wiring
**Status:** CODE COMPLETE (network paths need creds to run)
**Started:** 2026-07-17
**Note:** creds-gated paths built blind; user tests with secrets in `.env` later.

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-028 | GitHub App OAuth install flow | DONE | MED | FR-GH-1: install-url → callback → list installation repos → link; app-JWT → installation token |
| GD-029 | Real R2 upload in upload-sourcemaps.mjs | DONE | MED | FR-BLD-2: S3 PutObject to R2 + Debug-ID injection, strip maps, register index |
| GD-030 | Taskip @sentry/nextjs integration reference | DONE | HIGH | FR-SDK-1..8, FR-BLD-1: client/server/edge config, tunnel route, kill switch, withSentryConfig |

### Sprint Stats
- Total: 3  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 3  /  BLOCKED: 0
- Tokens: ~85k total

### Verification notes (Sprint 5)
Verified locally (no external round-trip): GitHub App **manifest** generation (personal →
github.com/settings/apps/new, org → /organizations/<org>/settings/apps/new, least-privilege
contents+metadata read), `/github/app` state, kill-switch **config** endpoint on ingest
(FR-SDK-8), Settings create-App UI renders. Also updated: GD-025 SES marked shipped-in-code,
GD-024 R2 now applied in symbolicate + real PutObject in the uploader.
Needs a real GitHub/R2 round-trip to fully exercise (user tests with creds):
- GD-028: create App → convert manifest → install → list repos → link.
- GD-029: uploader PutObject to R2 + artifact registration end-to-end.
- GD-030: `taskip-integration/` reference files are copy-into-Taskip (compiled there, not here).

## Sprint 6 — Complete all remaining pending work (no Docker/CI)
**Status:** COMPLETE (2 partial: saved-searches, rrweb playback)
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-033 | Events partition auto-management | DONE | HIGH | NFR-SCALE-3: roll monthly partitions forward + drop aged (retention drops partitions) |
| GD-034 | Back-pressure shedding | DONE | MED | FR-WRK-4: shed traces/replay before errors when queue deep |
| GD-035 | Frequency/spike alerts | DONE | MED | FR-ALR-3: "seen > N times in M min" |
| GD-036 | Alert rule editor UI + snooze | DONE | MED | FR-ALR-5/7: create/edit/delete rules, snooze window |
| GD-037 | Editable Highlights | DONE | MED | FR-UI-7: pin/unpin highlight fields |
| GD-038 | Global search (⌘K) | DONE | MED | brief §3: issue/trace/shortId lookup |
| GD-039 | Keyboard nav (j/k/e/a) | DONE | LOW | brief §1/§5 feed nav |
| GD-040 | Issue merge | DONE | LOW | FR-GRP-6: merge two issues |
| GD-041 | Saved searches + real time-range | PARTIAL | LOW | brief §7 |
| GD-042 | Assignee picker | DONE | MED | FR-UI-4: assign to member |
| GD-043 | Suspect commit/blame + regression range | DONE | LOW | FR-GH-4/5 (live needs creds) |
| GD-044 | Create GitHub Issue from issue | DONE | LOW | FR-GH-6 (live needs creds) |
| GD-045 | Auto-resolve on commit/PR message | DONE | LOW | FR-GH-7 webhook (live needs creds) |
| GD-046 | Onboarding "waiting for first event" | DONE | MED | brief §6 |
| GD-047 | Forgot/reset password | DONE | MED | brief §5 |
| GD-048 | DSN key regenerate/revoke UI | DONE | MED | FR-ADM-5 |
| GD-049 | Member role-change UI | DONE | LOW | FR-ADM-6 |
| GD-050 | Internal metrics endpoint | DONE | MED | NFR-MNT-2: queue depth, latency, drops |
| GD-051 | Drop counters (session/client_report) | DONE | MED | FR-ING-6 |
| GD-052 | Per-project usage stats | DONE | LOW | FR-RET-3 |
| GD-053 | Real rrweb replay playback | DONE | LOW | FR-RPL — completed in GD-105 (Sprint 25): all recordings streamed to R2, decode endpoint, rrweb-player render |

### Sprint Stats
- Total: 21  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 19  /  PARTIAL: 2
- Tokens: ~180k total

### Verification notes (Sprint 6)
CLI/browser verified: partition auto-roll (events_2026_09/10 created ahead), metrics endpoint
(queue/latency/drops), usage stats, alert rule CRUD + snooze + **frequency alert fired** ("Spike"
email), issue **merge** (NEXTJS-2→NEXTJS-1, times_seen summed), password **forgot/reset**, DSN
**regenerate/revoke** (old key deactivated), members role UI, kill-switch drop counters. Web renders:
Alerts editor, Issue-detail assignee picker + GitHub card + editable Highlights, global search ⌘K,
keyboard nav, multi-select merge bar, onboarding, forgot/reset pages, Settings system-metrics.
Partial: GD-041 saved-searches (shareable ?query URL works; named-search chips not built),
GD-053 rrweb DOM playback (player shell + timeline; real DOM render needs the R2 recording blob).
GitHub advanced (GD-043/44/45) code-complete; live needs a GitHub App install.

## Sprint 7 — Close no-creds gaps + prove v2 (Laravel) readiness
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-054 | Oversized blob → R2 streaming + pointer | DONE | HIGH | FR-ING-4/FR-RPL-2: stream oversized replay_recording/attachment to R2, enqueue pointer, local fallback |
| GD-055 | Automated test suite | DONE | HIGH | ingest caps/gzip/framing + envelope round-trip smoke (ingest→pipeline→issue) |
| GD-056 | Laravel/PHP v2 readiness proof | DONE | MED | FR-WRK-7/FR-MAP-10: platform:"php" event groups, symbolication skipped |

### Sprint Stats
- Total: 3  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 3  /  BLOCKED: 0
- Tokens: ~55k total

### Verification notes (Sprint 7)
- GD-054: ingest streams oversized replay_recording/attachment to R2 + enqueues a pointer;
  local fallback (no R2) keeps items inline — verified live: replay still round-trips (+1 row).
- GD-055: 19 automated tests, all green (ingest 6: framing/caps/gzip/blob-fallback; workers 13:
  fingerprint, source-map apply, envelope parse, PHP platform, ingest→pipeline→issue smoke +
  idempotency). `npm test` at root runs them.
- GD-056 (Laravel/PHP v2 readiness, SRS §12): tests prove a `platform:"php"` event normalizes with
  native frames, groups deterministically (FR-WRK-7), and skips symbolication (FR-MAP-10). Adding
  `sentry/sentry-laravel` in v2 is therefore client-config only — no backend change.

## Sprint 8 — Docs: README + screenshots, DEPLOY.md, INTEGRATION.md
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-057 | README rewrite + page screenshots | DONE | HIGH | overview, architecture, features, quickstart + 7 embedded screenshots |
| GD-058 | DEPLOY.md (Coolify + VPS) | DONE | HIGH | provision, env, migrate, Nixpacks per-service / pm2, maps, GitHub App, ops |
| GD-059 | INTEGRATION.md (existing Sentry apps) | DONE | HIGH | repoint DSN, tunnel, disable SaaS upload, kill switch, other SDKs, migration |

### Sprint Stats
- Total: 3  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 3  /  BLOCKED: 0
- Tokens: ~45k total

## Sprint 9 — Multi-project management (create + delete, full UI)
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-060 | Create/delete project API | DONE | HIGH | FR-ADM: admin-gated `POST /projects` (provision dsn+envs+alert rule) + `DELETE /projects/:id` (cascade + manual events/spans, keep ≥1) |
| GD-061 | Project switcher + management UI | DONE | HIGH | sidebar dropdown switches currentProjectId; Settings "Projects" section: new-project form + delete (admin, confirm) |

### Sprint Stats
- Total: 2  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 2  /  BLOCKED: 0

### Verification notes (Sprint 9)
- Both apps typecheck clean (`tsc --noEmit`).
- DELETE cascade verified against live DB: throwaway project + dsn/env/alert/issue/event/trace/span/replay/notification/repo/release rows → controller's delete sequence removed **all** dependents, no FK error, other projects untouched.
- Create path mirrors register `provisionDefaultProject` (dsn key + 3 envs + default alert rule).
- Note: running api/web dev servers must restart to load the new `/projects` POST+DELETE routes.

## Sprint 10 — Dedicated Projects page + Integrations (R2/SES connect in-app)
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-062 | Projects → own page | DONE | MED | move project create/delete out of Settings into `/projects` route + sidebar nav; switcher links updated |
| GD-063 | `integrations` table + encrypted creds store | DONE | HIGH | NFR-SEC-5: new table (org,kind) AES-GCM `secretEnc`; shared crypto; migration 0004; r2/ses resolve env→DB (cached) |
| GD-064 | Integrations settings tab (R2 + SES) | DONE | HIGH | tabbed Settings; admin PUT/DELETE/Test per kind; write-only secret inputs; live Test (S3 ListObjects / SES GetSendQuota) |

### Sprint Stats
- Total: 3  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 3  /  BLOCKED: 0

### Verification notes (Sprint 10)
- Full monorepo typecheck + build clean; 19 automated tests still green (async `r2Configured()` didn't regress the ingest→pipeline smoke).
- Migration 0004 applied (additive: `integrations` table + `(org_id,kind)` unique index; partitioning untouched).
- Crypto/resolver chain verified against live DB: API `encrypt` → `integrations.secretEnc` → worker `getActiveIntegration` + shared `decrypt` round-trips exactly; ciphertext carries no plaintext; env unset so DB path is the live source.
- Precedence: env vars win (ops override); DB row used when env unset. **Set `APP_ENCRYPTION_KEY` (32-byte hex) in prod** — dev key is a fallback with a warning.
- Note: api/ingest/workers/web must restart to load the new `/integrations` routes + env→DB config resolution. R2/SES **Test** needs real creds to return ok.

## Sprint 11 — Dashboard, account self-service, empty states, nav cleanup
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-065 | No-project empty states | DONE | MED | reusable `NoProject` (admin CTA / member hint) on Issues, Dashboard, Settings general+github, Projects; switcher shows "No project" |
| GD-066 | Integrations sub-tabs by provider | DONE | LOW | Integrations tab → vertical rail (Cloudflare R2 / AWS SES / Others) with per-provider connection dot |
| GD-067 | Remove Traces from sidebar | DONE | LOW | Traces is issue-scoped (reached from issue detail); route kept for deep-links |
| GD-068 | Account self-service (profile + password) | DONE | MED | sidebar user block → AccountModal; `PATCH /auth/profile` (re-issues token), `POST /auth/change-password` (verifies current) |
| GD-069 | Dashboard overview page | DONE | HIGH | `GET /dashboard` org aggregate → stat tiles, most-frequent issues, per-project rollup, members, latency p50/p95, hour-of-day activity + peak; new default landing |

### Sprint Stats
- Total: 5  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 5  /  BLOCKED: 0

### Verification notes (Sprint 11)
- api + web typecheck clean; web prod bundle + HMR clean.
- `GET /dashboard` verified live with a signed dev JWT against real data: totals (projects/members/unresolved/events7d/activeUsers7d), top issue (reference incident, timesSeen 7), per-project rollup, latency p50/p95 from redis, 24-bucket hour histogram + peak — all aggregation SQL (extract-hour, count-distinct `user->>'id'`, inArray, joins) runs without error.
- New routes confirmed registered + auth-gated (401): `/dashboard`, `/auth/profile`, `/auth/change-password`.
- Profile/password endpoints route-verified but NOT exercised live (would mutate the real account login).
- Nav: Dashboard added as first item + default landing (`/` and `*` → `/dashboard`); Traces removed from sidebar (route retained).
- api restarted to load new routes; web HMR picked up the rest.

## Sprint 12 — Per-project SDK setup guide (member-facing) + email to dev
**Status:** COMPLETE
**Started:** 2026-07-17

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-070 | project.setupCompletedAt + setup endpoints | DONE | HIGH | migration 0005 (nullable col); `POST /projects/:id/setup` (member) mark complete/incomplete; list returns the flag |
| GD-071 | Email SDK setup to a developer | DONE | HIGH | `POST /projects/:id/setup/email` (member) → API SES mailer (env→DB), graceful `sent:false` when unset; client mailto fallback |
| GD-072 | Projects page integration guide (member) | DONE | HIGH | per-project expandable guide: steps + DSN Sentry.init (copy), setup badge + mark-complete, email-to-dev form; all member-accessible |

### Sprint Stats
- Total: 3  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 3  /  BLOCKED: 0

### Verification notes (Sprint 12)
- api + web typecheck clean; migration 0005 applied (additive nullable `setup_completed_at`).
- **Member-role flow cross-checked live** with a role:`member` JWT: lists projects (setup flag present) → `POST /setup {completed:true}` sets timestamp → re-list confirms → `POST /setup/email` returns `{sent:false, reason:"email (SES) not configured"}` (graceful; UI shows mailto fallback) → reset to incomplete. No admin gate on setup/keys endpoints (org-scoped only); create/delete stay admin.
- Once SES is connected (Integrations tab), the same email endpoint sends for real.

## Sprint 13 — Redirect to setup page after project create
**Status:** COMPLETE
**Started:** 2026-07-17

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-073 | Dedicated `/projects/:id/setup` page + post-create redirect | DONE | MED | extract `IntegrationGuide` to shared component; new focused setup page (breadcrumb, guide, Go-to-dashboard); create → `navigate(/projects/:id/setup)` instead of staying in list |

- Verify: web typecheck clean; pure client-route change (HMR, no restart). Guide component reused by both Projects list (inline expand) + the new setup page.

## Sprint 14 — Member-role authorization audit
**Status:** COMPLETE
**Started:** 2026-07-17

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-074 | Member access audit + gate GET /integrations & /metrics | DONE | HIGH | NFR-SEC-6: found 2 admin surfaces readable by members (integration config, system metrics) → gated admin; hid those Settings tabs from members |

### Verification notes (Sprint 14)
- Live matrix with a `role:member` JWT (23 endpoints): **all 17 sensitive/mutating endpoints → 403** (create/delete project, R2/SES read+write+test, /metrics, kill switch, DSN regen/revoke, repo link, upload token, member invite/role/remove, GitHub app create, alert CRUD). **All 7 member-allowed reads → 200/201** (dashboard, projects list, DSN public key, envs, issues, mark-setup, own profile).
- Secret-leak scan: `/projects/:id/keys` returns only the public write-only DSN (`publicKey/isActive/rateLimit`) — no secret/token/accessKey. `secretEnc` never leaves the server (integration list is admin-only + omits it).
- Fixes: `GET /integrations` + `GET /metrics` now admin-gated (were JwtGuard-only). Web hides Integrations + System Settings tabs from members (+ blocks landing on them via shared URL).
- Pre-existing gates confirmed correct: projects create/delete, admin controller (repo/ingest/keys/token/members), alerts, integrations write, github write.

## Sprint 15 — Themed 403 / 404 pages
**Status:** COMPLETE
**Started:** 2026-07-17

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-075 | Themed 403 + 404 pages | DONE | LOW | shared `StatusPage` (ghosted code + brand mark + actions, light/dark tokens); NotFound at `*`, Forbidden at `/403`; ProjectSetup reuses them (missing→404, 403→Forbidden) |

- Verify: web typecheck clean (HMR). `*` catch-all now renders themed 404 inside the shell (was a silent redirect); `/403` addressable; ProjectSetup denied/missing states reuse the pages.

## Sprint 16 — Per-project member access + project-access admin UI
**Status:** COMPLETE
**Started:** 2026-07-17

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-076 | project_members table + access choke point | DONE | HIGH | NFR-SEC-6: migration 0006 `project_members(project_id,user_id)`; `access.ts` (accessibleProjectIds/hasProjectAccess/assertProjectAccess) — admins all, members granted-only |
| GD-077 | Enforce access across all project-scoped endpoints | DONE | HIGH | projects list/keys/environments/setup, issues list/detail/act/merge, dashboard, misc traces/replays/alerts, metrics usage all scope to accessible ids |
| GD-078 | Admin grant/revoke API + Members UI | DONE | HIGH | `GET/POST /members/:id/projects`; Settings→Members per-member "Project access" checkboxes; Members+GitHub tabs now admin-only |

### Verification notes (Sprint 16)
- All workspaces typecheck clean; 19 tests green (issues.service refactor to principal-scoped didn't regress).
- Live grant/revoke matrix: member with **0 grants** → `/projects` empty, dashboard projects=0, issues empty, non-granted `/projects/:id/keys` → **403**. Admin `POST /members/:id/projects {[pid]}` → member now sees **1** project, keys→200, dashboard=1. Revoke → back to 0.
- Admins implicitly access every org project (no grant rows needed); members see only granted projects everywhere (list, switcher, dashboard, issues, traces, replays, alerts).
- New members start with **zero** project access — admin grants via Settings → Members → Project access (invite auto-opens the access editor).

## Sprint 17 — Docker packaging + open-source docs site (GitHub Pages)
**Status:** COMPLETE
**Started:** 2026-07-17

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-079 | Per-service Dockerfiles | DONE | HIGH | 2-stage Dockerfile per app (ingest/api/workers, build→runtime) + web→nginx (proxies /api); context=repo root, builds only shared+db+self |
| GD-080 | docker-compose.yml (full stack) | DONE | HIGH | postgres + redis + one-shot migrate + ingest + api + workers + web; healthchecks, service_completed_successfully gating, env_file .env + DB/REDIS host override, named volumes |
| GD-081 | MkDocs Material docs site + Pages workflow | DONE | HIGH | index/architecture/self-hosting-docker/deploy/configuration/integration + SRS/brief; `.github/workflows/docs.yml` → Pages; built clean locally (no broken links) |

### Sprint Stats
- Total: 3  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 3  /  BLOCKED: 0

### Verification notes (Sprint 17)
- `docker compose config` valid. Compose: postgres(16)+redis(7) healthchecks → one-shot `migrate` (workers image, `npm run db:migrate`, tsx kept) → ingest/api/workers/web gated on `service_completed_successfully`. `x-backend-env` anchor overrides DATABASE_URL/REDIS_URL (env_file `.env` still supplies secrets). web build-arg `VITE_API_URL=/api`; nginx proxies `/api/`→`api:4002/` (api sets no global prefix), SPA fallback to index.html. web api client fetches `${BASE}${path}` and all paths are leading-slash → proxy correct.
- Dockerfiles: build context = repo root (npm workspaces need all package.json + lockfile); each builds only `shared`+`db`+its own app; runtime stage copies whole `/app` (workspace symlinks). Node 20-slim; web → nginx 1.27-alpine.
- Docs: MkDocs Material built locally in a venv, exit 0, **no broken-link/missing-file warnings** (only the unrelated Material-2.0 team notice). Pages workflow installs mkdocs-material, `mkdocs build`, upload-pages-artifact→deploy-pages. **One-time repo setup: Settings → Pages → Source = "GitHub Actions".** Site URL: https://xgeniousllc.github.io/geniusDebug/
- README + DEPLOY.md updated: Docker is now the recommended path; both link the docs site.
- Note: `.env.example` POSTGRES_PASSWORD line NOT added — the guard-secrets hook blocks editing `.env.example`; documented in `docs/configuration.md` + self-hosting guide instead.

## Sprint 18 — Production deploy on Coolify (Nixpacks per-service)
**Status:** COMPLETE
**Started:** 2026-07-18

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-082 | Deploy 4 apps on Coolify (Nixpacks) + managed PG/Redis | DONE | HIGH | ingest/api/workers/web as separate Coolify apps, Nixpacks, Coolify-managed Postgres + Redis; per-app env via `{{project.*}}` shared vars |

### Sprint Stats
- Total: 1  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 1  /  BLOCKED: 0

### Verification notes (Sprint 18) — live deploy, host `localhost` server on Coolify
- **api** (`debug-api.taskip.net`, port 4002): Build `npm run build -w @geniusdebug/shared -w @geniusdebug/db -w @geniusdebug/api`, Start `node apps/api/dist/main.js`, **Pre-Deploy** `npm run db:migrate` (tsx present, dev deps not pruned). `/auth/status` → `{firstRun:true}` after migrate.
- **ingest** (`ingest.*`, port 4001), **workers** (background, dummy port 4003 + healthcheck disabled — pure BullMQ consumer, no HTTP listener). Build/start mirror api with their own `-w` target.
- **web** (`debug.taskip.net`): Nixpacks **static site** (nginx:alpine) + **SPA** both checked; Base Directory `/`, Build `npm run build -w @geniusdebug/web`, Publish `apps/web/dist`, build-arg `VITE_API_URL=https://debug-api.taskip.net` (absolute → web calls api directly, no nginx /api proxy). NOT the repo's `apps/web/Dockerfile` (that nginx hardcodes `api:4002` upstream → crashes off-compose).
- **Gotchas hit & fixed:** (1) empty **Start Command** → `bash -c: option requires an argument` restart loop — set start cmd. (2) Coolify **shared vars don't auto-inject** — each app needs `KEY={{project.KEY}}` reference rows; project scope alone = localhost fallback. (3) Nixpacks static first pointed at `apps/web/dist` (Base Directory wrong) → "failed to detect app type" — Base Directory must be `/`. (4) workers create form **requires a Port** even for background — dummy 4003 + disable healthcheck.
- **Datastores:** use Coolify **internal** URLs (Postgres internal URL worked; Redis must be internal `redis://…:6379`, NOT the external `rediss://…:6380` — external TLS URL mis-parsed by ioredis → ENOENT socket).
- **Secrets:** DB + Redis passwords were pasted in chat during setup → **rotate** in Coolify. `JWT_SECRET` + `APP_ENCRYPTION_KEY` generated fresh (32-byte hex) and set as project shared vars; `NODE_ENV=production` deliberately NOT set (would prune tsx → migrate fails).
- Branch `dev` pushed (`origin/dev` @ 71bb68c) alongside `main`; app source identical across both.

## Sprint 19 — GitHub callback fix, invite email, branded service pages
**Status:** COMPLETE
**Started:** 2026-07-18

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-083 | Fix GitHub App OAuth callback 500 | DONE | HIGH | FR-GH-1: GitHub REST rejects no-User-Agent (403) → convertManifest threw → raw 500. Added `user-agent` to every github fetch; callback now try/catches → redirects `?github=error&reason=` + logs real cause (incl. GitHub body) |
| GD-084 | Invite email + accept-invite link | DONE | HIGH | FR-ADM-6: invite() now sets a 7-day reset token, emails the invitee via API SES mailer (env→DB) with an "Accept invite & set password" link; graceful fallback returns `inviteLink` when SES unset — web Members shows a copy-link box |
| GD-085 | Branded home/404/500 pages (ingest/api/workers) | DONE | MED | shared `webpages.ts` (wantsHtml + themed HTML/JSON builders); Nest `HtmlExceptionFilter` + RootController on ingest+api (browser→HTML, clients→JSON, 4xx keep JSON contract); workers got a tiny http face (home/health/404) on WORKERS_PORT |

### Sprint Stats
- Total: 3  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 3  /  BLOCKED: 0

### Verification notes (Sprint 19)
- All workspaces typecheck clean; 19 tests green (6 ingest + 13 workers).
- Live smoke (compiled `node dist`): ingest/api/workers each serve HTML home to `Accept: text/html`, JSON to SDK/curl (no Accept) + `application/json`; `/nope` → 404 HTML/JSON; `/health` contract unchanged; api `GET /dashboard` no-token still returns `401 {statusCode,message}` JSON even with browser Accept (4xx passthrough — SPA error handling intact).
- GD-083 root cause proven by code path: Node global fetch (undici) sends no default UA → GitHub 403. Fix needs an api redeploy on Coolify to take effect; retry create-App flow after.
- GD-084/GD-085 need api restart on Coolify; invite email only sends once SES is connected (Integrations tab) — until then admin copies the link.

## Sprint 20 — GitHub manifest 404 fix
**Status:** COMPLETE
**Started:** 2026-07-19

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-086 | Fix GitHub App manifest conversion 404 | DONE | HIGH | FR-GH-1: `convertManifest` POSTed to singular `/app-manifest/{code}/conversions` → GitHub 404 → callback `?github=error&reason=manifest+conversion+failed%3A+404`. Fixed to plural `/app-manifests/{code}/conversions` (github.service.ts:66) |

### Sprint Stats
- Total: 1  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 1  /  BLOCKED: 0

### Verification notes (Sprint 20)
- One-word path fix (singular→plural) matches GitHub REST `POST /app-manifests/{code}/conversions`. api typecheck clean. Needs api redeploy on Coolify, then retry create-App → install flow.

## Sprint 21 — Multiple GitHub Apps + disconnect
**Status:** COMPLETE
**Started:** 2026-07-19

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-087 | Allow multiple GitHub Apps per org + disconnect | DONE | MED | FR-GH-1: schema/API allow >1 github app row per org; Settings→GitHub lists all connected apps with Disconnect; create appends (dedupe by app id) |
| GD-088 | GitHub repo connect in project setup flow | DONE | MED | UX: extract shared `GithubConnect` component; add "Connect a GitHub repo" card to `/projects/:id/setup` (post-create) so repo linking is part of onboarding, not just Settings |

### Sprint Stats
- Total: 2  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 2  /  BLOCKED: 0

### Verification notes (Sprint 21)
- Schema: `github_apps_org_uq` (uniqueIndex on org_id) → `github_apps_org_idx` (plain index). Migration `0007_milky_abomination.sql` (DROP INDEX + CREATE INDEX, no partition impact) generated + applied; live pg_indexes confirms swap (only remaining unique is `github_apps_pkey`).
- API: `appCallback` no longer wipes existing apps — appends, deduping by `(orgId, appId)`. `GET /github/app` returns `{installed, slug, apps:[{id,slug,ownerLogin,installUrl}]}`. New `POST /github/app/:id/disconnect` (admin-gated, org-scoped) deletes one app. Repo/suspect-commit/create-issue flows now resolve the right app via `installationTokenForOrg` (tries each org app's creds until one mints a token, since the install callback only carries installation_id). Dead `appForOrg` removed.
- Web Settings→GitHub: "Connected apps" list, each row = slug · owner + Install/add-repos link + Disconnect (danger btn, admin). Create form appends ("Create another App"). Repo picker + manual link unchanged.
- GD-088: extracted the whole GitHub flow (`GithubApp`+`ManualLink`+`GithubLink`) from Settings.tsx into shared `components/GithubConnect.tsx` (export `GithubConnect`); Settings imports it. Added a "Connect a GitHub repo" `Card` to `ProjectSetup` (`/projects/:id/setup`) after the SDK guide — repo linking is now part of the post-create onboarding. Manual link works inline on the setup page; the App-install redirect still lands on `/settings?installation_id=` (repo picker appears there) — acceptable seam, not changed.
- api+web+db typecheck clean; web prod build clean (116 modules); 19 tests green (6 ingest + 13 workers). Needs api+web redeploy on Coolify.

## Sprint 23 — Fix prod DSN host (ingest unreachable)
**Status:** COMPLETE
**Started:** 2026-07-19

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-095 | DSN host from VITE_INGEST_ORIGIN, not web-host:4001 | DONE | HIGH | prod DSN pointed browsers at `debug.taskip.net:4001` (web host + raw container port) → connection refused; Coolify/Traefik only publish ingest on its own domain over 443. New `lib/ingest.ts` (ingestHost/buildDsn) reads `VITE_INGEST_ORIGIN` (dev fallback localhost:4001); rewired IntegrationGuide/Settings/Onboarding. **Coolify: give ingest app domain `ingest.<domain>` (Domains `https://ingest.<domain>:4001`), DNS → server IP, set web build-arg `VITE_INGEST_ORIGIN=https://ingest.<domain>`.** |

### Sprint Stats
- Total: 1  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 1  /  BLOCKED: 0

## Sprint 22 — Revert to 1 app/repo per project, project rename, member invite UX, email 500 fix
**Status:** COMPLETE
**Started:** 2026-07-19

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-089 | Revert to one GitHub App per org (keep disconnect) | DONE | HIGH | user: individual project = one repo + one app. Restore `github_apps_org_uq` unique (migration 0008, dedupe-then-unique); `appCallback` replaces org app; `GET /github/app` → `{installed, app}`; GithubConnect single-app UI + Disconnect (no "create another") |
| GD-090 | GitHub repo connect + status inside setup guide | DONE | MED | move `GithubConnect` into shared `IntegrationGuide` so setup page + Projects inline guide both show connect + connected-repo status; drop the separate ProjectSetup card |
| GD-091 | Edit project name | DONE | MED | FR-ADM: `PATCH /projects/:id {name}` (admin, org-scoped, slug unchanged); Settings→General editable Project name (edit/save/cancel) |
| GD-092 | Fix setup-email 500 | DONE | HIGH | `mailer.sendEmail` now try/catches SES send + aws-sdk import → returns `{sent:false, reason}` (was throwing → 500 on the setup/email + invite paths); UI shows reason + mailto/copy fallback |
| GD-093 | Member invite UX: surface errors, pending badge, reinvite | DONE | MED | FR-ADM-6: invite/remove/role mutations get `onError` → inline message (was silent on "email already a member" 400); `GET /members` returns `pending` (live reset token) + `invitedAt`; "invite pending" badge + `reinvite` btn; new `POST /members/:id/reinvite` (fresh 7-day token, resend/return link) |

| GD-094 | Project-scoped invitations (auto-grant, drop access editor) | DONE | MED | user: invite is scoped to a project → invitee auto-gets access to the current project; `POST /members` accepts `projectIds` and inserts `project_members` (org-checked, onConflictDoNothing); web Members invite auto-passes the current project + shows "grants access to <project>"; removed per-member Project-access checkbox editor + auto-open (MemberProjects component deleted; grant/get endpoints kept) |

### Sprint Stats
- Total: 6  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 6  /  BLOCKED: 0

## Sprint 24 — Fix prod 403 "invalid or disabled key" (UUID project id truncation)
**Status:** COMPLETE
**Started:** 2026-07-19

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-096 | Ingest: auth by public key, stop requiring URL projectId match | DONE | HIGH | FR-ING-1: Sentry SDK `dsnFromString` strips a non-numeric DSN project id to leading digits (`/^\d+/`), so our UUID `034b5b59-…` was POSTed as `/api/034/envelope/`; `DsnService.resolve` required `entry.projectId === projectId` → always null → 403. Public key is globally unique + write-only → authenticate on it alone (Sentry's model). Controller now keys countDrop/rate-limit/blobs/job off the resolved `key.projectId`, not the mangled URL id. |

### Sprint Stats
- Total: 1  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 1  /  BLOCKED: 0

## Sprint 27 — AI fix suggester P1 (DeepSeek, diagnose-only)
**Status:** CODE COMPLETE (needs DeepSeek key + redeploy)
**Started:** 2026-07-19

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-116 | AI fix suggester — P1 diagnose (DeepSeek only) | DONE | HIGH | FR-AIF (`docs/ai-fix-suggester.md` P1). **Single provider = DeepSeek** (OpenAI-compatible `chat/completions`, `response_format: json_object`). New `fix_suggestions` table (migration 0010); `deepseek.ts` client resolves key from env `DEEPSEEK_API_KEY` or the encrypted `integrations` row (kind `deepseek`, single `apiKey` secret); `SuggestService` grounds the prompt on the issue + latest event's **symbolicated in-app frames** (stored pre/post context — no GitHub fetch in P1), forces structured JSON (rootCause/confidence/evidence/patches/testSuggestion/needMoreContext), validates + persists, caches by (issue,event). `POST/GET /issues/:shortId/suggest` — project-access scoped, **any role**, read-only (inert data, no repo writes — guardrail per doc §3). Web: "Suggested fix" card on Issue Detail (confidence badge, root cause, evidence, red/green diff, Regenerate, "AI · Unverified" tag). Integrations tab gains a DeepSeek provider (apiKey + model, live key Test). |

| GD-117 | AI fix suggester — P2 grounded source fetch | DONE | HIGH | FR-AIF P2: `SuggestService.fetchSources` pulls ±40-line windows for the top in-app frames from the **linked GitHub repo at the errored release commit** (`releases.commitSha`, else repo default branch) via new `GithubService.getFileContent` (contents API, base64). Secrets masked pre-send (`redact.ts` — API-key/PEM/`key=val` patterns; `.env*`/`.pem`/`.key`/`id_rsa` files skipped entirely — 5 unit tests). Windows added to the prompt line-numbered with `>` on the crash line; `baseSha`+`sourceFiles` stored in `meta`. Degrades to P1 (stored context) when no repo/token. |

| GD-118 | AI fix suggester — P3 self-critique + calibrated confidence | DONE | HIGH | FR-AIF P3: after generation, an adversarial critique call (skeptical reviewer prompt) judges the patch — {addresses, compiles, risk, verdict, confidence, note}. `reject`→confidence forced low + reason surfaced in needMoreContext; `risk:high`→low; else adopt critique confidence (never upgrades past a risk flag). Critique stored in `meta`. Skipped when there's no patch to verify. |
| GD-119 | AI fix suggester — P4 human-approved draft PR (write guardrail) | DONE | HIGH | FR-AIF P4/§3: **the only repo-mutating path, model NOT in it.** New `fix_pull_requests` table + `repositories.pr_enabled` opt-in (migration 0011, default OFF). `POST /issues/:shortId/suggest/pr` (admin) → re-validate (suggestion owns issue, project access, `pr_enabled`, repo+token) → deterministic `applyUnifiedDiff` (throws on context drift → abort, 4 tests) → **new branch `genius-fix/<id>-<hash>` only, DRAFT PR only**, never default/existing branch, never auto-merge; idempotent per (suggestion, patchHash=sha256 of patches). `POST …/pr-enabled` admin toggle. Manifest now requests `contents:write`+`pull_requests:write` (existing App must re-approve). Web: "Open draft PR" button (admin, confirm dialog, "never merged" copy), enable-PRs toggle, View-draft-PR link. |

### Sprint Stats
- Total: 4  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 4  /  BLOCKED: 0
- Tests: 36 green (8 ingest + 14 workers + 14 api: 5 decode + 5 redact + 4 apply-diff). Migrations 0010+0011 applied. DeepSeek key verified live. **Full AI fix-suggester complete: P1 diagnose → P2 GitHub-source grounding → P3 self-critique → P4 human-approved draft PR.** Set DeepSeek key + (for PRs) re-approve the GitHub App for the elevated perms, enable draft PRs per repo, then redeploy api+web.

## Sprint 26 — Edge-case hardening (replays/traces/envelope/auth)
**Status:** CODE COMPLETE (needs migrate + redeploy)
**Started:** 2026-07-19

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-107 | Multi-segment replay assembly | DONE | HIGH | FR-RPL: session replay arrives as many `replay_recording` segments; each was a separate `replays` row and the player showed only one. Added `replay_id`+`segment_id` cols (migration 0009); `recording` endpoint now gathers ALL segments of a replayId in order, decodes each R2 blob, concatenates; Replays list collapses segments → one card per session (sums size/segments). |
| GD-108 | Replay ingest idempotency | DONE | HIGH | FR-WRK-2: at-least-once delivery re-inserted replay segments. Unique `(replay_id, segment_id)`; processReplay `onConflictDoNothing`. |
| GD-109 | Envelope `length` overrun guard | DONE | HIGH | FR-ING-3: all three parsers trusted the item `length`. Now reject overrun — ingest 400 "truncated item payload" (after the 413 size-cap), worker `parseEnvelope` stops at a bad tail, `splitOversizedBlobs` keeps remainder inline. |
| GD-110 | DLQ re-drive endpoint | DONE | HIGH | ops: `POST /metrics/dlq/redrive?limit=` (admin) re-enqueues dead-lettered jobs onto ingest — recovers replays lost to the old parse bug. |
| GD-111 | Global 401 handling | DONE | MED | web `api()` on 401 → clear token + redirect `/login?next=` (was toast spam, no re-login). |
| GD-112 | Scope time-range control to Issues feed | DONE | LOW | range select only rendered on `/issues` (it only filters that feed; was a confusing global no-op elsewhere). |
| GD-113 | Real transaction overwrites synthetic trace | DONE | MED | FR-TRC-4: `traces.synthetic` flag; error-synth row now overwritten by a later real `transaction` (onConflictDoUpdate setWhere synthetic=true). |
| GD-114 | GitHub issue create dedupe | DONE | LOW | FR-GH-6: record `github_issue` activity w/ url; repeat create returns existing url (`existing:true`), no duplicate GitHub issues. |
| GD-115 | split-blobs extraction test + obs counters + cleanup | DONE | LOW | `splitOversizedBlobs` DI'd putter + test (raw-bytes extraction); worker counts `envelope_parse_error` drop; removed dup `jsonwebtoken` dep key. |

### Sprint Stats
- Total: 9  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 9  /  BLOCKED: 0
- Tests: 27 green (8 ingest + 14 workers + 5 api). Migration 0009 applied. Needs redeploy: ingest+api+workers+web.

## Sprint 25 — Fix create-GitHub-issue 500, richer alert email, error-only trace waterfall
**Status:** CODE COMPLETE (needs api/workers/web redeploy)
**Started:** 2026-07-19

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-097 | Fix "Create GitHub Issue" 500 | DONE | HIGH | FR-GH-6: App manifest only requested `contents:read`+`metadata:read` → POST /issues 403 → `createIssue` threw raw → Nest 500. Added `issues:write` to manifest; `createIssue` now includes GitHub body in error; controller try/catches → 400 with reason ("re-approve the App to grant issues:write"). **Existing installed App must re-approve permissions to gain issues:write.** |
| GD-098 | Alert email: link + culprit + count | DONE | MED | FR-ALR-6: email was just `<h2>title</h2><p>Trigger: new</p>`. Now branded HTML: trigger label, shortId/level/times-seen, culprit, and an "Open issue in geniusDebug →" button to `${WEB_URL}/issues/:shortId`. alerts.ts resolves the issue row; needs `WEB_URL` env in workers. |
| GD-099 | Error-only trace waterfall resolves | DONE | HIGH | FR-TRC-4: errors carry a `trace_id` but no `transaction` item → no `traces` row → `/traces/:id` returned all-null → dead "Open trace waterfall". Worker now synthesizes a `traces` row from the error (onConflictDoNothing; real transaction spans still win). Web Trace page renders an "Error in this trace" card (+ hint to set `tracesSampleRate>0`) when spans empty but errors exist. |
| GD-100 | Global time-range filter (was dead placeholder) | DONE | MED | FR-UI-2: header "Since First Seen ▾" was a static `<span>` doing nothing (unbuilt half of GD-041). Now a real `<select>` (Last 24h/7d/14d/30d / Since First Seen) bound to persisted `useUi.range`; Issues feed passes `range` → `issueListQuerySchema` → service filters `issues.lastSeen >= now-window`. |
| GD-101 | Fix replay drop — byte-accurate envelope parse | DONE | HIGH | FR-RPL-2/FR-WRK-1: `parseEnvelope` split the whole envelope on `\n` assuming header+one payload line per item. `replay_recording` payloads are length-prefixed binary (compressed rrweb, contains `\n`) → naive split corrupted them → `JSON.parse` threw on a mid-payload line → whole job failed → 5× retry → dead-lettered → **every replay silently dropped** despite R2+SDK working. Rewrote parser to honor the Sentry item-header `length` (read exactly N bytes, binary-safe), else read to next `\n`. Regression test added. |
| GD-102 | Toast feedback on issue actions | DONE | MED | FR-UI-4: resolve/archive/mute/assign/merge + create-GitHub-issue were silent on success AND failure. New Zustand `toast` store + `<Toaster>` (mounted in Shell, auto-dismiss, error lingers 6s). Wired `onSuccess`/`onError` (surfaces server `ApiError.message`) on all mutations in Issues feed + Issue Detail. Dashboard is read-only (no actions to wire). |
| GD-103 | Fix ingest 400 "bad item header" on replay envelope | DONE | HIGH | FR-ING-3/FR-RPL-2: ingest `shallowValidate` also split framing on `\n` (2 lines/item) → length-prefixed binary `replay_recording` payload (contains `\n`) mis-framed → next line parsed as header → 400 before enqueue → replays rejected at the door (companion to GD-101 on the worker side). Rewrote the framing walk byte-accurate honoring item `length` (header scan + size caps only, payloads opaque, hot-path cheap). Regression test added (7 ingest tests green). |
| GD-104 | Doc: AI fix-suggester agent (NEXT STAGE) | DONE | LOW | Wrote `docs/ai-fix-suggester.md` — design for an agent that analyzes the symbolicated error + source pulled from the linked GitHub repo and suggests a probable fix (root cause + unified-diff patch), surfaced on Issue Detail. PLANNED/parked; phased P1 diagnose → P2 grounded patches → P3 draft PR. Not built — build after core stabilizes. |
| GD-105 | Real rrweb replay playback (closes GD-053) | DONE | MED | FR-RPL-5/6: (1) ingest now streams **every** `replay_recording` to R2, not just oversized — and byte-accurate (honors item `length`, stores RAW bytes; the old `\n`-split + utf8 re-encode corrupted the blob AND left small recordings with no R2 blob → no playback). (2) new api R2 read client + `GET /replays/:id/recording` → fetch blob, strip `{segment_id}\n`, zlib/gzip/raw decode → rrweb events (5 unit tests, incl. Sentry's zlib-deflate default). (3) web ReplayPlayer mounts real `rrweb-player` (lazy 129KB chunk) when events present; masked placeholder + reason when no blob. |

| GD-106 | Any role can create a GitHub issue | DONE | MED | FR-GH-6/NFR-SEC-6: `createGithubIssue` was `admin only` (403 "admin only" for members). Dropped the admin gate; `issueRepoContext` now scopes by `accessibleProjectIds(user)` so any role with access to the issue's project can open a GitHub issue (and suspect-commits read is access-scoped too, was org-wide). Web already showed the button to all roles. |

### Sprint Stats
- Total: 10  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 9  /  PLANNED: 1 (GD-104 doc-only)
- Tests: 26 green (7 ingest + 14 workers + 5 api). Needs redeploy: ingest+api+workers+web.

### Notes
- **Replays root cause was a backend bug** (GD-101), not client config: the length-prefixed `replay_recording` item crashed the envelope parser. Fixed. `replay_event` metadata now inserts and replays appear once redeployed.
- ingest+api+workers+web typecheck clean; 14 worker tests green (+1 replay-framing regression); web prod build clean. Needs redeploy on Coolify (ingest+api+workers+web).

### Verification notes (Sprint 22)
- api+web+db typecheck clean; web prod build clean; 19 tests green.
- Migration 0008 applied (dedupe dup github_apps per org → restore `github_apps_org_uq` unique). Supersedes GD-087's multi-app (Sprint 21) per user correction.
- Email 500 root cause: SES now configured (Integrations) but `SendEmailCommand` threw (unverified sender/sandbox/creds) and mailer didn't catch → Nest 500. Now graceful `{sent:false, reason}`; both `/projects/:id/setup/email` and invite/reinvite return the reason so UI offers copy/mailto.
- Members: `pending` = user still holds a live (unexpired, unconsumed) reset token; cleared when they set a password via the invite link. Reinvite mints a new token + resends.
- Needs api+web redeploy on Coolify. To actually deliver mail, verify the SES sender identity / move out of sandbox (the reason string will say which).

## Sprint 28 — Ingest error handling + UI action button states
**Status:** IN PROGRESS
**Started:** 2026-07-19

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-120 | Ingest 500: try/catch + meaningful error responses | DONE | HIGH | ingest controller has zero try/catch — any thrown exception (R2 split, queue add, DB) becomes generic 500. Wrap critical path, log real error, return meaningful status (400/503). |
| GD-121 | Issue action buttons: state-aware labels | DONE | HIGH | Issues feed + Issue detail always show Resolve/Archive/Mute regardless of current status. Read issue.status, show context-appropriate buttons (resolve↔unresolve, archive↔unarchive, mute↔unmute). Backend already supports all reverse actions. |
| GD-122 | GitHub disconnect cascade + unlink + link feedback | DONE | HIGH | disconnectApp now cascade-deletes linked repos; new POST /projects/:id/unlink endpoint; link/unlink/disconnect mutations all show toast feedback; disconnect invalidates repo queries too; link button shows loading state. |
| GD-123 | Replay playback: try fallback r2Prefix + R2 startup warning | DONE | MED | recording endpoint now tries canonical blobs/ key when stored r2Prefix is fallback path (replays ingested before R2 configured); better error messaging on replay page; ingest logs warning when R2 unconfigured. |

### Sprint Stats
- Total: 4  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 4  /  BLOCKED: 0

## Sprint 29 — Mobile responsive, replay masking, local Next.js test app
**Status:** IN PROGRESS
**Started:** 2026-07-19

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-124 | Mobile-responsive dashboard (web SPA) | DONE | HIGH | Shell sidebar to hamburger drawer on mobile (off-canvas < md, static >= md, backdrop + close btn); fixed overflow grids Issues/IssueDetail/Traces/ReplayPlayer/Settings/Alerts to stack/shrink; Issues hides Users col + tightens gap < sm; container padding px-4 sm:px-6. web typecheck clean. |
| GD-125 | Replay masking: only mask password | DONE | HIGH | FR-SDK-7/FR-RPL-4: taskip-integration/sentry.client.config.ts maskAllText/Inputs/blockAllMedia -> false, maskInputOptions.password:true. Replay now readable; passwords masked. Same config in test app. |
| GD-126 | Local Next.js test app (errors+replays to local ingest) | DONE | HIGH | test-nextjs/ standalone Next 15 + @sentry/nextjs, tunnelRoute /monitoring -> localhost:4001 (no CORS), sampling 1.0 for testing, buttons: render crash/handled/async/rejection + email+password masking check. Boots 200 on :3100. User sets DSN in .env.local + configures R2 for replay playback. |
| GD-127 | Fix replay "video not showing" — segment-key collision overwrote FullSnapshot | DONE | HIGH | FR-RPL/FR-WRK-2: Sentry sends each replay segment in its OWN envelope, all sharing one event_id(=replayId). Ingest keyed the R2 blob blobs/<pid>/<eventId>/<idx>-replay_recording with idx always 0 -> every segment OVERWROTE the same object; last segment (e.g. seg 7, incremental-only) clobbered segment 0's FullSnapshot -> rrweb had no snapshot -> no playback. Worker also defaulted segmentId to 0 (replay_event lacks it) -> all segments collapsed to one DB row. Fix: ingest parses the plaintext {"segment_id":N} prefix of the rrweb payload, keys the blob by real segment_id, and passes segmentId on the BlobPointer; worker uses pointer.segmentId for the DB row. Segments now coexist. |
| GD-128 | Issues feed: triage buttons always-visible top-right (not hover) | DONE | LOW | brief §7: moved Resolve/Archive/Mute out of the group-hover block onto the pills row, right-aligned (ml-auto), always visible + state-aware. |
| GD-129 | Replay renders blank — swap broken rrweb-player for rrweb Replayer | DONE | HIGH | FR-RPL-5/6: after GD-127 the recording served 20 valid events (Meta+FullSnapshot+increments) but the player showed a blank white box. Root cause: rrweb-player 2.1.0 (Svelte wrapper) renders only its outer shell under Vite dep pre-bundling — no iframe, no controller, NO error (proved with a clean synthetic mount: 0 iframes). Rewrote RrwebCanvas to use rrweb's low-level `Replayer` directly (same v2 schema as Sentry), with fit-to-width transform scaling + `min-w-0`/`minmax(0,1fr)` grid so the recorded viewport doesn't force horizontal page overflow. Also restarted the stale api (2-day uptime, predated R2 connect) which was the Events:0 cause. Verified live in-browser: replay plays the recorded DOM, Meta shows Events 20, no overflow. |
| GD-130 | Replay player transport: play/pause, scrubber, event markers, fullscreen | DONE | LOW | brief §10: replaced text-only Pause/Restart with a real transport — circular Play/Pause, draggable timeline scrubber + playhead, mm:ss current/total, colored event-marker dots (error red / warning amber / interaction green / event purple) from the rrweb custom-event stream, legend, Restart, fullscreen. Total duration taken from authoritative replay.durationMs (rrweb getMetaData().totalTime + raw event span were skewed by outlier Sentry event timestamps → showed garbage like 2971148:19). Markers anchored to the FullSnapshot timestamp + duration, off-window outliers dropped. rAF playhead polling via getCurrentTime(). |

| GD-131 | Replay player: no autoplay/loop, render cursor + interactions | DONE | MED | FR-RPL: (1) mount paused at frame 0 (`pause(0)`) — no autoplay; play only on user Play click; on `finish` stop + pin to end, never loop. (2) `mouseTail` enabled → recorded mouse cursor + path render (was `mouseTail:false`). (3) Duration authoritative from Meta-anchored event span (rrweb timeline trails past the last real event → playhead overran 0:08/0:06); tick stops cleanly at computed end. Verified live: loads paused, plays on click, cursor renders, stops at end w/o loop. |

| GD-132 | Issue Detail improvements: embedded replays + events chart + similar issues | DONE | HIGH | brief §8: (1) "Replays in this issue" section — new `GET /issues/:shortId/replays` (segments collapsed to sessions), embedded rrweb player (extracted shared `ReplayViewer`) + session list. (2) Events-over-time bar chart from issueCounts. (3) "Similar Issues" rail panel — new `GET /issues/:shortId/similar` (culprit + type + title-token Jaccard scoring, green→red gradient). Right-rail Session Replay card now reflects the embedded section. api+web typecheck clean; verified issue detail renders (no crash, conditional sections). |

### Sprint Stats
- Total: 9  /  TODO: 0  /  IN_PROGRESS: 0  /  DONE: 9  /  BLOCKED: 0

### Out-of-band DONE this session (verified live)
- GD-139 | Test-app full form + replay full-page fit | DONE | test-nextjs page 4: a real signup form (name/email/password/phone/company/role select/plan radios/message textarea/2 checkboxes) → submit → TypeError captured (whole fill flow in one replay). Filled + submitted live: replay = **37 events**. Replay player now fits the WHOLE recorded page (not just the viewport) scaled to width + capped height (MAX_H 560), re-fit on a 500ms interval — because rrweb wasn't replaying scroll so below-the-fold form was hidden. Verified: entire form with recorded values renders, password masked, rest readable. web typecheck clean.

## Sprint 30 — Queued feature backlog (Sentry-parity)
**Status:** TODO (user queued these mid-session; prioritize before building)
**Started:** 2026-07-19

### Tickets

| Ticket | Title | Status | Priority | Description |
|--------|-------|--------|----------|-------------|
| GD-133 | Share Issue modal | DONE | MED | Sentry-style "Share Issue" dialog: copyable issue/event URL, "Include Event ID in link" toggle, Copy Link + Copy as Markdown, and a "Create a public link" toggle (unauth read-only view for outside-org sharing). Needs a public-share token + unauthenticated read route. |
| GD-134 | Issue categories + Warnings view | DONE | MED | Categorize issues (error / warning / db_query / etc) via a `category` field; sidebar/tab filter `issue.category is …`; a "Warnings" feed variant. Needs schema `category` + worker classification + list filter. |
| GD-135 | Releases page | DONE | MED | `/releases` list: version/commit, stage (production/preview), adoption %, crash-free rate, crashes, new issues, 24h/14d sparkline. Needs release session/crash aggregation (sessions ingest is not built yet — scope check). |
| GD-136 | Performance / span explorer ("Worst Pageloads") | DONE | LOW | Trace/span analytics: count + p75/p90 of `measurements.lcp` over time (charts), span-samples table (span.op, duration, transaction, timestamp), filters. Large — needs span aggregation queries over the traces/spans tables. |
| GD-143 | Rich trace waterfall (Sentry-style span tree + web vitals + span panel) | DONE | MED | Upgrade the Trace page (GD-099): nested/indented span tree with per-span op+description+duration bars, a web-vitals header (LCP/FCP/INP/CLS/TTFB from transaction measurements), a click-to-open Span detail side panel (id, op, duration, "N% faster/slower than avg", attributes list), trace meta (browser/OS/release/env), search-in-trace. Data: traces+spans tables already store the tree; measurements come on the transaction envelope. Overlaps GD-136. |
| GD-144 | Issue detail: show full HTTP Request + all Contexts + rich Tags | DONE | HIGH | We STORE event.request (url+headers), full contexts (browser/os/device/culture/react/trace/app), and tags — but only render 3 context cards + flat tags, and NEVER show HTTP Request. Sentry shows everything because the SDK sends it in the envelope (we receive+store it). Add: HTTP Request card (method+url+headers table, scrub cookies/auth), render ALL context objects generically (+ Trace Details, Culture, React, User geography), and Sentry-style derived Tags (browser/os/device/environment/handled/level/release/transaction/url/mechanism) merged with stored tags. Pure display of existing data. |
| GD-145 | Replay explorer parity with Sentry | DONE | MED | Match Sentry's replay page: per-replay tabs (Activity/Console/Network/Errors/Trace/Memory/Tags), AI session summary (narrative + timestamped steps, reuse DeepSeek), dead-click/rage-click detection, playback speed control, "See all replays" list with dead/rage/errors columns + duration. Data: rrweb events already carry console/network/clicks as breadcrumbs/custom events; derive tabs from them. NOTE: capture itself already matches Sentry (same SDK envelope) — this is the VIEWER UX. |
| GD-146 | Transaction measurements ingest (web vitals) | DONE | MED | Store transaction measurements (LCP/FCP/INP/CLS/TTFB) — new traces.measurements jsonb col (migration 0014), SentryTransactionPayload.measurements type, worker persists payload.measurements (onConflictDoUpdate too), trace API returns it (full-row select), web-vitals header on the Trace page (color-graded good/meh/poor). Unblocks GD-143 vitals header + GD-136 LCP data. Populates when a browser PAGELOAD transaction with vitals is processed (server "GET /" transactions carry none). typecheck clean; trace page verified (WebVitals null-safe). Needs workers+api+web redeploy. |
| GD-137 | Issue shortId = project-name prefix + random id | DONE | MED | Current shortId is `<PLATFORM>-<seq>` (e.g. `JAVASCRIPT-NEXTJS-5`) — looks odd + platform-based. Change to a project-name/slug prefix + short random id (e.g. `TASKIP-A1B2C3`), collision-checked per project. Touches fingerprint/grouping shortId generation in the worker (`issues_project_short_id_uq`); keep existing issues' ids stable (only new issues get the new format, or a migration/back-compat for links). |
| GD-138 | Issue Detail: replay video as a tab / anchored after stack trace | DONE | MED | GD-132 added "Replays in this issue" at the end of the left column; user wants it either as a dedicated tab in the tab bar (stack/breadcrumbs/tags/context/events → +replay) OR clearly placed right after the Stack Trace section at the bottom. Add a "Replay" tab (badge with count) that renders the embedded `ReplayViewer`, and/or move the section directly below the stack-trace panel. |
| GD-142 | Copy error as AI-agent markdown (for automated fixing) | DONE | MED | Add a "Copy for AI agent" action (on issue detail / Share modal) that exports the WHOLE error as a structured .md file optimized for an AI coding agent to identify + fix: title, level, culprit, symbolicated stack trace with source context + in-app frames, breadcrumbs, tags/context (browser/OS/release), latest event, repro steps from replay interactions, and the linked GitHub file/line. Optionally AI-generated (DeepSeek, reuse FR-AIF pipeline) to add a root-cause summary + suggested fix section. Output copyable + downloadable. Complements GD-133 share + GD-116 AI suggester. |
| GD-140 | Log every occurrence + replay per trigger, show stacked under the issue | DONE | HIGH | Same fingerprint = one issue, but EVERY trigger must record its own event occurrence + its own replay, and the issue detail shows them as a stack (occurrence list + replay list, newest first, each selectable → loads that occurrence's event + replay). Verify worker persists a distinct `events` row per delivery (idempotent on event_id, NOT deduped away) and that each replay session links to the issue; ensure `events`/replays lists paginate. Currently times_seen bumps + events stored, but confirm no accidental dedupe drops occurrences and the UI stacks them (events tab + Replays-in-issue already list; make occurrence↔replay correlation explicit). |

| GD-141 | Replay plays only the static first frame — increments not casting | DONE | HIGH | ROOT CAUSE FOUND + FIXED: Sentry replay events had MIXED timestamp units — some ms (~1.78e12), some **seconds** (~1.78e9, with decimals). rrweb computed a 1.78-TRILLION-ms timeline and scheduled the real events outside the played window → only the FullSnapshot rendered (frozen still). Fix `normalizeEvents()` in ReplayPlayer: seconds→ms (`*1000` when `<1e12`) + sort by timestamp before `new Replayer`. **Verified live: replay now plays — mouse cursor + mouseTail path animate, timeline markers spread correctly, no longer a still.** REMAINING sub-issue (client-side, not backend): typed **input field VALUES** don't reflect in playback. Decoded the recording: source-5 Input events ARE captured (12 of them) but every `text` is empty `""` (only checkbox `isChecked` survives). Reproduced with BOTH MCP typing AND native JS `input` events → not an automation artifact. So **Sentry 8.55 replay masks input text to empty despite `maskAllInputs:false`** in `sentry.client.config.ts` — a client recorder config/behavior (affects taskip-integration equally), NOT a geniusDebug player/backend bug. Tried 4 approaches (maskAllInputs:false; +maskInputOptions; +`unmask` selectors; **moved init to `instrumentation-client.ts`** + deleted sentry.client.config.ts) — ALL still record empty input text. The values are stripped at RECORD time (empty `text` in the R2 blob), so geniusDebug can't recover them; and the golden rule forbids forking the Sentry browser SDK. CONCLUSION: hard Sentry 8.55 recorder wall, not config-fixable in this setup. Realistic paths: (a) deeper Sentry-SDK investigation — a specific 8.x version, an `_experiments` flag, or a known issue/workaround; (b) accept masked inputs as privacy (playback + mouse + clicks + scroll + which fields were touched all replay). Playback itself (the reported "still image") is FIXED. **RESOLVED — input masking is EXPECTED Sentry behavior, proven by inspecting the user's OWN taskip.sentry.io replay: Sentry's product masks email+password as asterisks (`****`); typed values never reach the recording in Sentry either.** So it's not a geniusDebug bug or missing config — no replay tool shows raw input values. Matched Sentry's default in both configs (maskAllInputs:true) so inputs render as length-preserving asterisks (a field was clearly filled) instead of empty; page text stays readable. Also confirmed our replay player design matches Sentry's (timeline + event markers + play/fullscreen). Earlier note: So the masking config is NOT reaching the replay recorder (or Sentry 8.55 always empties buffered on-error input text). STRONGEST next hypothesis: Next 15.5 + Sentry 8.55 loads **`instrumentation-client.ts`**, not `sentry.client.config.ts` — replays still work via an auto/default init that uses DEFAULT masking (maskAllInputs:true → empty). NEXT STEP: move the client Sentry.init into `instrumentation-client.ts` and re-test. Deprioritized — the reported bug (playback) is fixed; masked inputs may be acceptable privacy (DOM + mouse + clicks + which fields touched all replay). Config changes kept (correct intent). |

### Sprint Stats
- Total: 8  /  TODO: 8  /  IN_PROGRESS: 0  /  DONE: 0  /  BLOCKED: 0

### Verification notes — GD-129 (replay playback rendered, live)
- Logged into dashboard (persisted browser session), opened /replays/<pk> — Events flipped 0 -> 20 after api restart.
- Diagnosed blank player: `.rr-player > .rr-player__frame` present but EMPTY (0 descendants, 0 iframes, 0 controller, no console error). Synthetic clean mount of rrweb-player 2.1.0 also produced 0 iframes -> confirmed the wrapper is broken under Vite, not our data/StrictMode.
- Fix: `import { Replayer } from 'rrweb'` + `import 'rrweb/dist/style.css'`; new Replayer(events,{root,skipInactive,mouseTail:false}).play(); scale `.replayer-wrapper` to container width.
- Screenshotted playback: recorded test-app DOM renders (heading, DSN banner, all 3 sections, email+password fields), Play/Pause/Restart work, layout no longer overflows. web typecheck clean.
- Needs web redeploy on Coolify (the built web bundles rrweb now).

### Verification notes — GD-127 (replay playback, live end-to-end)
- Drove test app (:3100) in browser: typed email+password, clicked around, fired handled error.
- BEFORE fix: R2 had 1 object, internal header {"segment_id":7}, 332B, decoded 6 events types [3,5,3,3,5,5] — NO FullSnapshot -> not playable (proved the overwrite).
- AFTER fix (fresh replay 50dcc5da...): segment 0 blob 3136B decodes to 20 events types [4,5,2,3,...] — Meta(4)+FullSnapshot(2)+increments -> PLAYABLE:true. Recording endpoint returns >=2 events incl. snapshot -> rrweb-player renders.
- 37 tests green (9 ingest incl. new multi-segment-key test + 14 workers + 14 api). Needs ingest+workers redeploy on Coolify. Old pre-fix replays stay broken (already-overwritten blobs); new ones play.
- Note: APP_ENCRYPTION_KEY is unset locally -> all services use the dev fallback key (consistent, so R2 works). Set a real 32-byte hex key in prod.

### Verification notes (Sprint 29)
- GD-124: web `tsc --noEmit` clean. Shell = fixed off-canvas drawer (`-translate-x-full` -> `translate-x-0`, `md:static md:translate-x-0`) + hamburger (`md:hidden`) + backdrop + in-drawer close; nav closes on route change. Grids: `grid-cols-1 (sm|lg):grid-cols-[...]`. Live browser check at 375px NOT run (needs dashboard login).
- GD-125: only-password masking; server-side beforeSend still scrubs auth header + cookies.
- GD-126: `npm install` clean, `next dev` compiles instrumentation + Sentry, serves 200 at http://localhost:3100. DSN unset -> Sentry.init skipped + page shows warning banner (expected until user adds .env.local). Replay **playback** still needs R2 on local geniusDebug.
