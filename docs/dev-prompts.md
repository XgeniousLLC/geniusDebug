# geniusDebug — Development kickoff prompts

Copy-paste prompts for building geniusDebug with Claude Code, in order. Open the repo in Claude Code so it auto-loads `CLAUDE.md`, then work **one phase per session/turn**, review the diff, and commit before moving on.

## How to use
- **Go in order.** Each phase builds on the last. Don't skip ahead.
- **Let it use the skills.** `verify-against-srs` (map work to FR-*/NFR- IDs) and `drizzle-change` (schema/migrations) are in `.claude/skills/`.
- **Review + commit per phase.** Small, traceable commits that cite SRS IDs.
- **Prepend this primer** to any fresh session:

> **Primer:** You're working in the geniusDebug repo. Read `CLAUDE.md` and the relevant parts of `docs/geniusDebug-SRS.md` (the spec) and `docs/frontend-design-brief.md` (the UI). Follow the golden rules — especially: never affect Taskip's performance, keep the ingest hot path cheap, treat the Sentry envelope format as a pinned contract, keep the pipeline platform-agnostic, secrets server-side only. Plan before coding; cite the SRS requirement IDs you satisfy; end with a verification step.

**MVP milestone 1** = Phases 0–5 + 8: empty repo → a Sentry event flows ingest → worker → grouped Issue → visible in the dashboard feed. Phases 6–14 layer on the rest.

---

## Phase 0 — Prime & plan (no code)
```
Read CLAUDE.md, docs/geniusDebug-SRS.md, and docs/frontend-design-brief.md.
Don't write code yet. Summarize: (1) the four-part architecture, (2) the seven golden rules in your own words, (3) the monorepo layout you'll create. Then propose a phased build plan as a checklist, and for the first 3 phases list the SRS requirement IDs each covers. Flag anything in the spec you find ambiguous.
```

## Phase 1 — Monorepo scaffold
```
Scaffold the monorepo per CLAUDE.md's suggested layout: apps/ingest, apps/workers, apps/api (NestJS + TypeScript), apps/web (Vite + React + Tailwind + Zustand + TypeScript), and packages/db, packages/shared. Use pnpm workspaces + Turborepo, TypeScript strict everywhere, shared ESLint + Prettier, and a root .env.example with placeholders (NEVER a real .env). No app-specific logic yet — just a clean skeleton where each service boots with a /health endpoint and the web app renders a blank shell. Run the build to prove everything compiles, then stop.
```

## Phase 2 — Database package (Drizzle)
```
Use the drizzle-change skill. Implement packages/db: the full Drizzle schema for the SRS §7 data model (organizations, users, memberships, projects, dsn_keys, org_tokens, environments, repositories, releases, source_map_artifacts, issues, events, issue_counts, traces, spans, replays, alert_rules, notifications, issue_activity) with the enums, foreign keys, and indexes the SRS names (issue list, symbolication, events, uniqueness). Add the postgres.js client with the typed query API ({ schema }), drizzle.config.ts, and generate the first migration. Then add a SECOND, hand-authored migration converting `events` to PARTITION BY RANGE (timestamp) with monthly partitions + a default partition. Store all tokens hashed. Generate and review the SQL — do not apply to a real database.
```

## Phase 3 — Shared types
```
Implement packages/shared: TypeScript types for the Sentry envelope items we ingest (event, transaction, replay_event/replay_recording, session, client_report) and our internal domain DTOs (normalized event, issue, trace, span). These are the contract between ingest, workers, api, and web. Keep them platform-agnostic (an event's `platform` can be javascript or, later, php). No runtime logic — types + a couple of zod schemas for boundary validation.
```

## Phase 4 — Ingest service (the hot path)
```
Implement apps/ingest per SRS §5.2 and §4.1 and the golden rules. Endpoint POST /api/:projectId/envelope/ speaking the Sentry envelope protocol. It MUST: authenticate the DSN public key (query param or X-Sentry-Auth); enforce per-project rate limits + quotas in Redis (429 + Retry-After); gunzip and shallow-validate envelope framing only; enforce size caps (≤1 MiB/event item, ≤200 MiB/envelope → 413); stream oversized replay_recording/attachment items straight to R2 and enqueue only a pointer; enqueue to BullMQ; return 202 fast (target p95 < 25 ms). NO symbolication, grouping, or DB writes inline. Accept both direct and tunnelRoute delivery. Add tests that a real Sentry envelope is accepted and enqueued and that oversized/badly-authed requests are rejected. Finish with the verify-against-srs skill citing the FR-ING IDs.
```

## Phase 5 — Workers pipeline (event first)
```
Implement apps/workers per SRS §5.3–§5.4. Consume the BullMQ queue with concurrency, retries + backoff, and a dead-letter queue. Pipeline: parse envelope items by type but implement ONLY `event` this phase (stub transaction/replay routing). Map Sentry event fields to our model (FR-WRK-6); compute the fingerprint (FR-GRP-1); upsert the Issue — bump times_seen, update first/last seen, detect regression (FR-GRP-5); persist the event; be idempotent on event_id (FR-WRK-2). Keep it platform-agnostic (FR-WRK-7); skip symbolication for now (stub FR-MAP). Unit-test fingerprinting, grouping, and idempotency. Verify against the SRS (verify-against-srs) citing FR-WRK/FR-GRP.
```

## Phase 6 — Source maps + symbolication
```
Implement the source-map path (SRS §4.3, §5.1a, §5.5). (1) scripts/upload-sourcemaps.mjs: inject Debug IDs (@sentry/cli), upload maps to R2 keyed by Debug ID, register the artifact index + release/commit/repo with the api, strip maps from public output, fail loudly on error. (2) The releases artifact-registration endpoint (secret org-token auth). (3) The worker symbolication step: match the event's Debug ID → source_map_artifacts → fetch the map from R2 (cache in Redis) → resolve frames, add source context, mark in-app vs framework, fall back to raw frame + warning if missing, and SKIP entirely when platform !== javascript (FR-MAP-10). Test symbolication on a sample minified stack + map.
```

## Phase 7 — Dashboard API
```
Implement apps/api per SRS §5.6 and §4.5. Authenticated REST: issues list (filter by environment/status/time/search, sort by last seen/first seen/events/users), issue detail (event, highlights, symbolicated stacktrace, breadcrumbs, tags, context, all-events), and actions (resolve/archive/mute/assign) that write issue_activity. Plus projects, environments, DSN key management. Email/password auth scoped to the org with admin/member roles (NFR-SEC-6). Tests for the list filters and the resolve/regression flow. Cite FR-UI/FR-ADM.
```

## Phase 8 — Web: design system + Issues feed
```
Implement apps/web starting with the DESIGN SYSTEM FOUNDATION from docs/frontend-design-brief.md — do this before any page. Set up the Tailwind theme with the §2 tokens (neutrals, accent, level/status colors) for light AND dark; build the base components from §4 (button incl. split-button, level pill, status chip, tag, code/stack-frame block, table/feed row, and explicit loading/empty/error states); wire in the brand assets from brand/ (GeniusDebugIcon, favicon.svg as the tab icon, wordmark). THEN build the global shell (§3: sidebar, env selector, search) and the Issues feed (brief §7 / FR-UI-1..4) against the api, using TanStack Query for server state and Zustand for UI state. Use tokens, never hardcoded hex. Take light + dark screenshots of the feed to verify it matches the brief.
```

## Phase 9 — Issue detail + Highlights (FR-UI-5/6, FR-MAP, FR-GH-3)
```
Build the Issue Detail page per brief §8 and SRS FR-UI-5/6: header + action bar, the editable Highlights panel (handled/level/transaction/url/trace), symbolicated stack trace with source context and "Open in GitHub" per frame, breadcrumbs, tags, context, all-events, and the activity trail. Wire the trace + replay entry points (stubs ok until Phases 10–11). Screenshot to verify against the reference incident.
```

## Phase 10 — Transactions + Trace waterfall (FR-TRC-*)
```
Enable the `transaction` envelope item in the worker (store traces + spans) and build the Trace waterfall page per brief §9 / SRS §5.7: span tree + time-positioned bars, error markers, span drawer linking back to the Issue. Link Issue Detail's Trace ID to it.
```

## Phase 11 — Session Replay (FR-RPL-*)
```
Enable replay_event/replay_recording ingestion (assemble segments in R2, metadata in Postgres) and build the Replay player per brief §10 / SRS §5.8: DOM playback, timeline with error markers, synced breadcrumbs, masked inputs visible. This is the most complex item type — do it last of the three.
```

## Phase 12 — Alerts + SES (FR-ALR-*)
```
Implement alert rules + notifications per SRS §5.9: new-issue and regression alerts, frequency rules, per-project rule config, and — first-class — dedupe/throttle so the team is never spammed. Send via AWS SES with a templated email + deep link. Build the Alerts pages (brief §11). Test that a burst of the same issue produces one throttled email.
```

## Phase 13 — GitHub integration (FR-GH-*)
```
Implement the GitHub App linking flow per SRS §5.12: install → callback → list/link repo, stored encrypted. Tie releases to commit SHAs, and make stack frames deep-link to GitHub at the exact commit + line. Add the Settings → GitHub page (brief §12). Suspect-commit/blame is optional (FR-GH-4).
```

## Phase 14 — Safety, retention, Taskip wiring, acceptance
```
Finish the v1 essentials: the remote kill switch / runtime config (FR-SDK-8) so geniusDebug can be throttled or disabled in Taskip without a redeploy; retention purge jobs for events/replays/maps (FR-RET-*); and the Taskip-side @sentry/nextjs config + tunnel route (frontend/app/monitoring, SRS §5.1). Then run the full acceptance path from SRS §9 end-to-end against the reference incident and report a coverage table with the verify-against-srs skill.
```

---

*Tip:* after each phase, ask Claude to run the `verify-against-srs` skill and produce an `ID | status | note` table, and to update the SRS/design-brief if the implementation revealed a gap.
