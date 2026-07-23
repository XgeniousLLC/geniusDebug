# Software Requirements Specification (SRS)
## geniusDebug — Minimal Error Monitoring & Debugging Platform

| | |
|---|---|
| **Product** | geniusDebug |
| **Version** | 1.5 — **v1 build spec (final)** |
| **Status** | Draft for review |
| **Author** | Engineering, Xgenious |
| **Date** | 16 July 2026 |
| **Primary consumer** | Taskip (Next.js frontend) |
| **Client SDK strategy** | **Reuse the open-source Sentry SDKs** pointed at geniusDebug — v1: `@sentry/nextjs` (Taskip frontend). v2: `sentry/sentry-laravel` (PHP backends). No custom SDK is built. |

> **Changelog v1.1:** Client instrumentation changed from a hand-built geniusDebug browser SDK to **reusing `@sentry/nextjs`** configured to send to the geniusDebug backend (custom DSN + `tunnelRoute`). geniusDebug's ingest now speaks the **Sentry envelope protocol**. This removes the riskiest part of the build (cross-browser capture, stack parsing, replay recording) and lets the team focus on ingest, processing, and the dashboard.
>
> **Changelog v1.2:** (1) Source maps now upload **automatically to Cloudflare R2 on every deploy** (Debug-ID based, no manual step) — §4.3, §5.1a, §5.5. (2) Added first-class **GitHub integration** (§4.4, §5.12): link a project to its repo, tie releases to commits, and deep-link every stack frame to the exact source line on GitHub. Data model gains `repositories` + commit fields.
>
> **Changelog v1.3:** PostgreSQL access standardized on **Drizzle ORM** (`drizzle-kit` migrations) — §2.5, §7.
>
> **Changelog v1.4:** Documented **Laravel compatibility** — because the ingest speaks the Sentry envelope protocol, the **`sentry/sentry-laravel`** SDK works against the same backend for PHP/Laravel services (server-side errors + tracing). Added platform-agnostic processing requirements so PHP events group and render correctly, and clarified that symbolication/source-maps/replay/tunnel apply to the browser platform only.
>
> **Changelog v1.5 (final for v1 build):** **Laravel/PHP support moved to v2** (§12 Roadmap) to keep v1 focused on the Taskip Next.js frontend. v1 retains only two cheap, forward-compatible decisions — a platform-agnostic pipeline (FR-WRK-7) and skip-symbolication-when-not-JS (FR-MAP-10) — so v2 is a small add, not a rewrite. This is the finalized v1 build specification.

---

## 1. Introduction

### 1.1 Purpose
geniusDebug is a lightweight, self-hosted error monitoring and debugging platform. Its goal is to capture, group, and surface **frontend runtime errors** from the Taskip Next.js application with enough context — stack trace, source-mapped code location, request/route, device, distributed trace, and a short session replay — to reproduce and fix the error quickly.

It is deliberately a **minimal Sentry alternative**: it implements only the subset of Sentry capabilities the team actually uses day-to-day, and nothing else. The two driving motivations are:

1. **Cost** — Sentry's pricing (event volume, replay quota, seats) is overkill for the team's real usage.
2. **Fit** — the team uses a small, well-understood slice of Sentry; owning that slice removes vendor lock-in and lets it be tuned to Taskip.

### 1.2 Scope
This SRS specifies **v1** of geniusDebug. In scope for v1:

- Integration of the **Sentry Next.js SDK (`@sentry/nextjs`)** into Taskip (client + edge/SSR runtime), configured to send to geniusDebug — **not** a custom-built SDK.
- An **ingest API** that accepts the **Sentry envelope protocol** and receives events without impacting the monitored app's performance.
- Asynchronous processing (via a **Redis** queue) that performs grouping, source-map symbolication, replay assembly, and alerting.
- **Error capture & grouping** into deduplicated *Issues* with an event stream.
- **Stack traces + source maps** — de-minification of Vercel production builds.
- **Distributed tracing / waterfall** — trace + span view linking related errors.
- **Session replay** — rrweb-style DOM replay of the moments leading to the error, captured with an on-error buffer to protect app performance.
- **Email alerts** via **AWS SES** with de-duplication/throttling.
- A **dashboard** (React + Zustand + Tailwind) for triage: Issues list, Issue detail, Highlights, Replay, Trace.
- Multi-project, multi-environment, release-aware data model.
- **Platform-agnostic ingest (v1 hygiene).** The ingest is Sentry-envelope-based, so it can accept events from any Sentry SDK. v1 keeps the processing pipeline platform-agnostic (FR-WRK-7) but ships **Next.js only**. **Laravel/PHP support (`sentry/sentry-laravel`) is deferred to v2** — see §12 Roadmap. No custom work is needed in v1 beyond the two cheap hygiene requirements noted in §5.1b.

Out of scope for v1 — see §10.

### 1.3 Definitions, Acronyms, Abbreviations

| Term | Meaning |
|---|---|
| **Event** | A single captured occurrence (one error instance with full context). |
| **Issue** | A group of events sharing the same *fingerprint* (deduplicated error). |
| **Fingerprint** | Deterministic hash identifying "the same bug" for grouping. |
| **Culprit** | Human-readable location of the error, e.g. `./stores/inbox/useInboxConversations.ts`. |
| **DSN** | Data Source Name — the public key + host URL the Sentry SDK sends to; here it points at geniusDebug (`https://<publicKey>@<geniusDebug-host>/<projectId>`). |
| **Envelope** | Sentry's newline-delimited-JSON wire format: one envelope header line + repeating (item header, item payload) pairs. geniusDebug's ingest parses this. |
| **Item** | One entry inside an envelope, typed by its header: `event` (error), `transaction` (trace), `replay_event`/`replay_recording`, `attachment`, `session`, `client_report`. |
| **tunnelRoute** | `@sentry/nextjs` option that makes the SDK POST envelopes to a same-origin Next.js route (first-party) instead of cross-origin, defeating ad-blockers; the route forwards to geniusDebug ingest. |
| **Trace** | A distributed transaction identified by a `trace_id` (e.g. `bba7158e…d0375`). |
| **Span** | A timed operation within a trace (shown as a bar in the waterfall). |
| **Replay** | Recorded DOM/event stream that can be played back like a video. |
| **Symbolication** | Mapping minified `bundle.js:1:2345` back to real `file.ts:line:col` via source maps. |
| **Environment** | Deployment context, e.g. `vercel-production`. |
| **Release** | A specific deployed build/version, used to bind source maps to events. |
| **SES** | AWS Simple Email Service. |
| **R2** | Cloudflare R2 object storage. |

### 1.4 References
- Sentry Issue/Trace UI (screenshots provided by the team) — functional reference for v1 parity.
- `@sentry/nextjs` — the reused client SDK (open source, MIT).
- Sentry **Envelope** wire format & **Envelope Items** — the ingest contract (`develop.sentry.dev/sdk/foundations/envelopes/`, `.../data-model/envelope-items/`).
- Sentry Next.js **Build Options** (`withSentryConfig`: `tunnelRoute`, `sourcemaps.disable`, `release.create`) — `docs.sentry.io/platforms/javascript/guides/nextjs/configuration/build/`.
- rrweb — the DOM recorder underlying Sentry Replay.
- **Design system (authoritative for all UI):** `docs/frontend-design-brief.md` — tokens, global shell, every page, component states, each mapped to the FR-UI-* requirements here.
- **Brand mark & design source:** Claude Design project **"Frontend design brief"** (`geniusDebug Icon.dc.html`), implemented in **`brand/`** (`icon.svg`, `favicon.svg`, monochrome/glyph, `GeniusDebugIcon.tsx`). The brand palette **is** the design-brief palette — one system.

### 1.5 Reference incident (drives the requirements)
The following real Taskip error is used throughout this document as the canonical example the system must handle end-to-end:

> **`TypeError: Cannot read properties of undefined (reading 'json')`**
> Culprit: `./stores/inbox/useInboxConversations.ts` (anonymous)
> Transaction/route: `/:workspace/dashboard`
> Handled: yes · Level: error
> Trace ID: `bba7158e21264876b051c6a0535d0375` · Event ID: `844c595511064f80a01aa8a83c6318e8`
> Browser: Chrome Mobile 150 · OS: Android 10 · Env: `vercel-production`
> Issue short ID: `JAVASCRIPT-NEXTJS-Z`

---

## 2. Overall Description

### 2.1 Product perspective
geniusDebug is a standalone platform composed of four cooperating parts:

1. **Client SDK — reused `@sentry/nextjs`** embedded in Taskip. It captures errors, traces, and replay data and ships them out asynchronously as Sentry **envelopes**. geniusDebug builds no browser SDK; it only configures this one (custom DSN + `tunnelRoute`) and consumes its output.
2. **Ingest service** — a thin, horizontally-scalable NestJS HTTP endpoint that speaks the **Sentry envelope protocol** (`POST /api/{projectId}/envelope/`), authenticates, lightly validates, and enqueues payloads as fast as possible.
3. **Processing workers** — NestJS workers consuming the Redis queue: grouping, symbolication, replay assembly, persistence, and alert evaluation.
4. **Dashboard + API** — a NestJS REST/GraphQL API and a React SPA for triage.

```
                       (async, non-blocking)
 ┌──────────────┐  HTTPS   ┌──────────────┐  enqueue  ┌─────────┐  consume  ┌───────────────┐
 │  Taskip App  │ envelope▶ │   Ingest      │ ───────▶ │  Redis   │ ────────▶ │   Workers      │
 │+@sentry/nextjs│ (tunnel)│  (NestJS)     │  fast 202 │  Queue   │           │  (NestJS)      │
 └──────────────┘          └──────────────┘           └─────────┘           └──────┬────────┘
        │                                                                          │
        │ replay blobs / source maps (direct, presigned)                          │ persist / read
        ▼                                                                          ▼
 ┌──────────────┐                                                          ┌───────────────┐
 │ Cloudflare R2│ ◀────────────────────────────────────────────────────── │  PostgreSQL    │
 │ (blobs)      │                                                          │  (metadata)    │
 └──────────────┘                                                          └──────┬────────┘
                                                                                  │
   ┌──────────────┐   REST/GraphQL   ┌──────────────┐   read                      │
   │ Dashboard    │ ◀──────────────▶ │  API (NestJS)│ ◀───────────────────────────┘
   │ (React SPA)  │                  └──────┬───────┘
   └──────────────┘                         │ send
                                            ▼
                                      ┌───────────┐
                                      │  AWS SES  │  email alerts
                                      └───────────┘
```

### 2.2 Product functions (summary)
- Capture handled/unhandled errors and promise rejections from Taskip.
- Attach rich context: request, route/transaction, user, device/browser/OS, release, environment, breadcrumbs, tags.
- Group events into Issues by fingerprint; track first/last seen, count, and status.
- Symbolicate minified stack traces using release-scoped source maps.
- Correlate errors to a distributed trace and render a span waterfall.
- Record and replay the session leading up to an error.
- Notify the team by email on new/regressed issues, with throttling.
- Provide a triage dashboard: list, filter, inspect, assign, resolve, archive, mute.

### 2.3 User classes and characteristics

| User class | Description | Primary needs |
|---|---|---|
| **Developer** | Fixes Taskip bugs. | Fast triage, accurate source location, replay, trace. |
| **Team lead / triager** | Assigns and prioritizes issues. | Filtering, assignment, resolve/archive, alert tuning. |
| **Admin** | Manages projects, keys, retention, members. | Project/DSN management, quotas, data retention. |
| **System (SDK)** | Automated client. | Reliable, low-overhead ingestion. |

### 2.4 Operating environment
- **Monitored app:** Taskip, Next.js (App Router), deployed on Vercel (`vercel-production`), targeting modern browsers incl. mobile Chrome/Android.
- **geniusDebug backend:** NestJS (Node LTS), PostgreSQL, Redis, deployed independently of Taskip (its own infra) so it can never contend for Taskip's resources.
- **Storage:** Cloudflare R2 (replay segments, source maps, attachments).
- **Email:** AWS SES.
- **Dashboard:** React 18 SPA, Zustand state, Tailwind, TypeScript.

### 2.5 Design & implementation constraints (mandated stack)
- Backend & workers: **NestJS + TypeScript**.
- Primary datastore: **PostgreSQL**, accessed via **Drizzle ORM** (TypeScript-first; `drizzle-kit` for migrations).
- Queue/broker & caching: **Redis** (BullMQ recommended).
- Blob storage: **Cloudflare R2** (S3-compatible API).
- Transactional email: **AWS SES**.
- Frontend (dashboard): **React + Zustand + Tailwind + TypeScript**.
- Client instrumentation: **`@sentry/nextjs` (open source, MIT)** — reused, not rebuilt. Pin to a single major version and treat its **envelope protocol** as the ingest contract.
- Additional compatible client **(v2)**: **`sentry/sentry-laravel` (open source, MIT)** for PHP/Laravel services — reused, same envelope contract, same ingest. Deferred to v2 (§12); v1 only keeps the pipeline platform-agnostic so this is a small future add.
- Ingest **must** implement the Sentry envelope endpoint and item parsing (see §4.1, §5.1a).

### 2.6 Assumptions and dependencies
- Taskip's CI can upload source maps to geniusDebug on each deploy (release step), with Sentry's own build-time upload **disabled** (`sourcemaps.disable`, `release.create: false`, no Sentry `authToken`).
- `@sentry/nextjs`'s license (MIT, client SDK only) is verified as acceptable for reuse against a self-hosted backend.
- The Sentry envelope protocol version emitted by the pinned SDK is stable for the life of that pin; an SDK upgrade is a reviewed change (may shift payloads).
- geniusDebug runs on separate infrastructure from Taskip.
- SES is out of sandbox (production sending) with a verified domain.
- R2 bucket + credentials are provisioned.
- v1 assumes a **single organization** (Xgenious) with multiple projects; full multi-tenant billing is out of scope.

---

## 3. System Architecture & Data Flow

### 3.1 Ingestion path (the hot path — must be cheap)
1. `@sentry/nextjs` buffers events client-side and sends them **asynchronously** as Sentry **envelopes**. By default it targets the DSN host; with `tunnelRoute` set it POSTs same-origin to a Next.js route handler in Taskip, which forwards the raw envelope to geniusDebug's `POST /api/{projectId}/envelope/`.
2. Ingest service authenticates the DSN public key, checks per-project rate limits/quota, does **schema-shallow** envelope validation only (well-formed items, size caps), assigns/keeps the `event_id`, and pushes the raw envelope onto a Redis queue. It returns **`202 Accepted`** immediately (target < 15 ms server time). Heavy item parsing happens in workers, not here.
3. Large items (replay recordings, attachments) arrive within the envelope stream. To keep the tunnel/ingest path cheap, the ingest **streams oversized item payloads straight to R2** and enqueues only a pointer; it never buffers large blobs in the request handler. (See §6.1 on Vercel body-size limits for the tunnel route.)

### 3.2 Processing path (async, can be slower)
Workers consume the queue and run a pipeline per event:
1. **Normalize** — parse envelope, extract exception/stacktrace, contexts, tags, request, user, trace linkage.
2. **Symbolicate** — resolve minified frames using the release's source maps from R2 (cached in Redis).
3. **Fingerprint** — compute the grouping hash (§5.4).
4. **Upsert Issue** — find-or-create the Issue, bump `times_seen`, update `last_seen`, detect **regression** (event on a resolved issue).
5. **Persist** — write the event row + JSON detail to PostgreSQL; link replay/trace.
6. **Alerting** — evaluate alert rules; enqueue SES email jobs (deduped/throttled).

### 3.3 Isolation guarantee
geniusDebug is deployed on its **own infrastructure**, separate from Taskip. Even under heavy geniusDebug load, Taskip is affected only by the SDK's tiny client cost (§6.1). If the ingest endpoint is slow or down, the SDK degrades gracefully (drops/queues locally) and **never blocks or throws into Taskip**.

---

## 4. External Interface Requirements

### 4.1 SDK → Ingest API (Sentry envelope protocol)
geniusDebug's ingest implements the **Sentry envelope endpoint** so the stock `@sentry/nextjs` SDK works unchanged.

- **Endpoint:** `POST /api/{projectId}/envelope/` (the SDK derives this from the DSN). When `tunnelRoute` is used, the SDK POSTs to Taskip's same-origin tunnel route, which forwards the raw body here.
- **Auth:** DSN **public key**, sent as a query param (`?sentry_key=…`) and/or `X-Sentry-Auth` header (public, write-only — cannot read data). Ingest validates it against the project.
- **Body:** newline-delimited JSON envelope — one envelope-header line, then repeating `{item header}` + `{item payload}` lines. Item `type` ∈ `event`, `transaction`, `replay_event`, `replay_recording`, `attachment`, `session`, `client_report`.
- **Encoding:** `gzip` supported; `Content-Type: application/x-sentry-envelope`.
- **Limits (mirror Sentry):** ≤ 1 MiB per event/transaction item, ≤ 200 MiB per decompressed envelope; enforce and return `413` beyond.
- **Response:** `200`/`202` on accept; `429` with `Retry-After` when rate-limited; `403` on bad key.

> **Note:** geniusDebug does **not** invent its own `/ingest` schema. Reusing Sentry's envelope format is what lets the team drop in the stock SDK; the format is treated as a versioned contract pinned to the SDK major version.

### 4.2 Blob storage (replay/attachments → R2)
- With the Sentry SDK, replay recordings and attachments arrive **inside the envelope** (`replay_recording`, `attachment` items). The ingest streams oversized item payloads straight to R2 and enqueues a pointer (§4.1, FR-ING-4) — it does not buffer them. No browser-side presigned upload is required for the Sentry flow.

### 4.3 Automatic source-map upload (deploy pipeline → R2)
Source maps SHALL be uploaded **automatically on every deploy**, with no manual step, and land in **Cloudflare R2**. The flow uses **Debug IDs** so maps match minified files reliably regardless of URL/release drift:

1. During the build, a small **geniusDebug uploader** (CLI/script or unplugin) injects a Debug ID into each built JS file and its `.map`, then:
2. Uploads the `.map` artifacts **directly to R2** (S3-compatible API, R2 credentials held server-side/in the build env), keyed by `projectId` + `debugId` (and tagged with `release` = git SHA + repo/commit).
3. Registers the artifact index (debug IDs, R2 keys, checksums, release, commit SHA, repo) with geniusDebug via `POST /api/{projectId}/releases/{release}/artifacts`, authenticated with a **secret** org token (not the public DSN).
4. **Deletes** the `.map` files from the public deploy output so they are never served to end users.

- The uploader runs inside the deploy build (Vercel post-build step) or a **GitHub Actions** workflow — whichever the team deploys from — so it is fully automatic.
- Large maps go **straight to R2**; only the lightweight index passes through the geniusDebug API.

### 4.4 GitHub integration (source control)
geniusDebug connects a project to its **GitHub repository** so errors link back to real source.

- **Install/connect:** OAuth or a **GitHub App** installation authorizes geniusDebug to read the org's repos; the admin links a repo (`org/repo` + default branch) to a geniusDebug project.
- **Release ↔ commit:** each release carries its commit SHA (and repo), set from `VERCEL_GIT_COMMIT_SHA` / `GITHUB_SHA` at deploy.
- geniusDebug uses this to build **deep links from stack frames to GitHub** (file @ exact commit + line) and, optionally, to fetch commit/blame data for suspect-commit hints (§5.12).

### 4.5 Dashboard ↔ API
- Authenticated REST (and/or GraphQL) API for: list issues, issue detail, events, trace, replay manifest, assign/resolve/archive/mute, alert rules, projects, members, and GitHub repo linking.

### 4.6 Notifications → SES
- Worker composes templated emails and calls the SES `SendEmail`/`SendRawEmail` API.

---

## 5. Functional Requirements

> Priority key: **[M]** = must-have v1, **[S]** = should-have v1, **[C]** = could-have if cheap.

### 5.1 Client Instrumentation — Configuring `@sentry/nextjs`

geniusDebug reuses the stock Sentry Next.js SDK. These requirements are about **configuring and constraining** it inside Taskip — no capture code is written by us. The SDK already provides uncaught-error + promise-rejection handlers, `captureException`/`captureMessage`, stack traces, breadcrumbs, browser/OS/device context, tracing, and replay; the work is wiring it to geniusDebug safely.

- **FR-SDK-1 [M]** Taskip SHALL initialize `@sentry/nextjs` in all three runtimes it uses — client, server, and edge (via `instrumentation.ts` + client config) — so client-component errors and SSR/edge errors are both captured.
- **FR-SDK-2 [M]** The DSN SHALL point at geniusDebug (`https://<publicKey>@<geniusDebug-host>/<projectId>`), configured via env var (`NEXT_PUBLIC_SENTRY_DSN` or equivalent), never hardcoded.
- **FR-SDK-3 [M]** `tunnelRoute` SHALL be enabled (e.g. `/monitoring`) so envelopes are sent **first-party** through Taskip and are not blocked by ad-blockers/privacy extensions (important for mobile, per the reference incident).
- **FR-SDK-4 [M]** React render errors SHALL be captured by wiring `global-error.tsx` and route-level `error.tsx` boundaries to `Sentry.captureException`.
- **FR-SDK-5 [M]** `environment` SHALL be set (`vercel-production`, `preview`, `development`) and `release` SHALL be set to the deploy's git SHA (`VERCEL_GIT_COMMIT_SHA`) so events match the uploaded source maps (§5.5).
- **FR-SDK-6 [M]** Sampling SHALL be configured conservatively: `tracesSampleRate` low (e.g. 0.1) and Replay in **on-error** mode (`replaysOnErrorSampleRate` = 1.0, `replaysSessionSampleRate` ≈ 0) to protect Taskip performance (§5.8, §6.1).
- **FR-SDK-7 [M]** PII controls SHALL be enabled: Replay text/input masking on by default, plus a `beforeSend`/`beforeSendTransaction` hook to scrub tokens/PII and drop unwanted events. User & tag context (`setUser`, `setTag`) SHALL carry `workspace`/tenant for triage.
- **FR-SDK-8 [M]** A **remote kill switch / runtime config** SHALL gate the SDK: Taskip fetches a small cached config (enabled flag + sample rates) so geniusDebug can be throttled or fully disabled **without a Taskip redeploy** if it ever misbehaves (see §6.1). If config/ingest is unreachable, the SDK stays silent and never throws into Taskip.
- **FR-SDK-9 [M]** Only the SDK features in use SHALL be bundled (tree-shake unused integrations; lazy-load Replay) to keep client weight down; measure the added bundle size against a budget in CI.
- **FR-SDK-10 [S]** SDK major version SHALL be **pinned**; upgrades are a reviewed change because they may alter the envelope payload the ingest parses.

### 5.1a Build-time configuration (`withSentryConfig` on Vercel)

- **FR-BLD-1 [M]** `withSentryConfig` SHALL be configured to **disable Sentry's SaaS upload**: `sourcemaps.disable: true` (or omit `authToken`) and `release.create: false`, and NOT set Sentry `org`/`project`/`authToken`. Source maps are handled by geniusDebug's own uploader (§4.3).
- **FR-BLD-2 [M]** The deploy pipeline SHALL run the **geniusDebug uploader automatically** (Vercel post-build step or GitHub Actions): produce maps → inject Debug IDs → **upload maps to Cloudflare R2** → register the artifact index (Debug IDs, `release`=git SHA, commit, repo) with geniusDebug → **strip maps from public output**. No manual upload step is permitted.
- **FR-BLD-3 [M]** The uploader SHALL read R2 and geniusDebug credentials from the build environment (Vercel/GitHub secrets), never committed to the repo, and fail the deploy loudly if upload fails (so releases are never left without maps).
- **FR-BLD-4 [S]** The tunnel route handler SHALL forward the raw envelope body and original headers to geniusDebug ingest unmodified, and SHALL respect Vercel serverless body-size/time limits (§6.1).

### 5.1b Additional Client Platform — Laravel (`sentry/sentry-laravel`) → **deferred to v2**

Laravel/PHP support has been **moved out of v1** to keep the first release focused on the Taskip Next.js frontend. It is **not** dropped: because the ingest speaks the Sentry envelope protocol, adding `sentry/sentry-laravel` in v2 is a client-config + light-processing task, **not** a redesign. Full v2 requirements are in **§12 (Roadmap — v2)**.

To keep that future cheap, v1 **retains two low-cost design decisions** now (they add nothing to the browser build but avoid a v2 rewrite):

- the event pipeline is **platform-agnostic**, keying off the `platform` field so core steps never assume JavaScript (defined in §5.3, **FR-WRK-7**).
- symbolication is **skipped when `platform !== javascript`** (defined in §5.5, **FR-MAP-10**).

Everything else Laravel-specific (DSN wiring, PHP release/commit linking, after-response sending, etc.) lives in §12 and is a **v2** deliverable.

- **FR-ING-1 [M]** SHALL implement the Sentry envelope endpoint `POST /api/{projectId}/envelope/` and authenticate the DSN **public key** (from `?sentry_key=` query param or `X-Sentry-Auth` header), rejecting unknown/disabled keys with `403`.
- **FR-ING-2 [M]** SHALL enforce **per-project rate limits and quotas** (token bucket in Redis) and return `429` with `Retry-After` when exceeded, so a runaway client cannot overwhelm the system or blow up cost.
- **FR-ING-3 [M]** SHALL gunzip and do only **shallow envelope validation** (well-formed header + item framing, size caps), then enqueue and return fast (target p95 < 25 ms). It SHALL NOT do symbolication, grouping, or DB writes inline; deep item parsing happens in workers.
- **FR-ING-4 [M]** SHALL enforce max item/envelope sizes (≤ 1 MiB per event item, ≤ 200 MiB per envelope) and return `413` beyond; oversized `replay_recording`/`attachment` payloads SHALL be streamed to R2 with only a pointer enqueued.
- **FR-ING-5 [M]** SHALL be horizontally scalable and stateless (all state in Redis/PostgreSQL).
- **FR-ING-6 [S]** SHALL honor Sentry **client reports** / sampled-out volume cheaply, recording aggregate counters for dropped events rather than full storage.
- **FR-ING-7 [M]** SHALL accept the envelope whether delivered directly (DSN host) or via Taskip's `tunnelRoute` forwarder, treating both identically.

### 5.3 Processing Pipeline (Workers)

- **FR-WRK-1 [M]** SHALL consume events from Redis (BullMQ) with concurrency, retries with exponential back-off, and a **dead-letter queue** for poison events.
- **FR-WRK-2 [M]** SHALL be idempotent on `event_id` (at-least-once delivery must not double-count `times_seen`).
- **FR-WRK-3 [M]** SHALL process the pipeline in §3.2 order and record processing latency metrics.
- **FR-WRK-4 [S]** SHALL back-pressure gracefully: if queue depth exceeds a threshold, shed the lowest-value data first (traces/replay before errors) rather than errors.
- **FR-WRK-5 [M]** SHALL parse each envelope item by `type` and route it: `event` → error pipeline (§5.4/§5.5); `transaction` → trace/span store (§5.7); `replay_event` + `replay_recording` → replay assembly (§5.8); `session`/`client_report` → aggregate counters; unknown types are ignored safely. Implementation SHALL be phased — `event` first, then `transaction`, then replay — so the MVP is not blocked on the most complex format.
- **FR-WRK-6 [M]** SHALL map Sentry event fields to geniusDebug's model (exception type/value/stacktrace, `contexts` browser/os/device, `request`, `user`, `tags`, breadcrumbs, `transaction`, `release`, `environment`, `trace_id`) so the dashboard shows the same data as the reference UI.
- **FR-WRK-7 [M]** Processing SHALL be **platform-agnostic**, keyed off the event `platform` field (`javascript`, `php`, …). Platform-specific steps (source-map symbolication, replay) SHALL be applied only where relevant; core steps (normalize → group → persist → alert) SHALL work identically across platforms. This is what lets `sentry/sentry-laravel` (§5.1b) share the same backend.

### 5.4 Error Grouping (Issues)

- **FR-GRP-1 [M]** SHALL compute a deterministic **fingerprint** per event. Default algorithm: normalized top in-app stack frames (module + function), else exception type + normalized message.
- **FR-GRP-2 [M]** SHALL group events with the same fingerprint into a single **Issue** and increment `times_seen`, updating `last_seen` and `first_seen`.
- **FR-GRP-3 [M]** Each Issue SHALL have a human-readable title (`Cannot read properties of undefined (reading 'json')`), a **culprit** (`./stores/inbox/useInboxConversations.ts`), a type (`TypeError`), and a **short ID** (e.g. `JAVASCRIPT-NEXTJS-Z`).
- **FR-GRP-4 [M]** SHALL track Issue **status**: `unresolved` (new/ongoing), `resolved`, `archived`/`ignored`, and `muted`.
- **FR-GRP-5 [M]** SHALL detect **regressions**: a new event on a `resolved` Issue re-opens it (status → `unresolved`, flagged as regressed) and MAY trigger an alert.
- **FR-GRP-6 [S]** SHALL support a manual **merge** of two Issues and honor a client-supplied fingerprint override (the Sentry event `fingerprint` field, settable in `beforeSend`).

### 5.5 Stack Traces & Source Maps

> Source maps and symbolication apply to **minified/browser platforms only** (JavaScript). Server platforms like PHP/Laravel already have real file paths, so they skip this stage entirely (FR-MAP-10, FR-PHP-4).

- **FR-MAP-1 [M]** Source maps SHALL be uploaded **automatically on every deploy** to **Cloudflare R2** (no manual step), via the deploy-pipeline uploader in §4.3.
- **FR-MAP-2 [M]** Maps SHALL be stored in R2 keyed by **Debug ID** (primary) with `release`/commit as secondary metadata, and indexed in PostgreSQL; a build's maps are immutable.
- **FR-MAP-3 [M]** Workers SHALL symbolicate minified frames to original file/line/column/function by matching the event's Debug ID to the stored map (falling back to release+URL). The reference incident resolves to `./stores/inbox/useInboxConversations.ts`.
- **FR-MAP-4 [M]** SHALL render **source context** (surrounding code lines) around the crashing frame when available in the map.
- **FR-MAP-5 [M]** SHALL clearly distinguish **in-app** frames from `node_modules`/framework frames.
- **FR-MAP-6 [M]** Each symbolicated in-app frame SHALL deep-link to the exact source on **GitHub** at the release's commit (`…/blob/<sha>/<path>#L<line>`) when the project is linked (§5.12).
- **FR-MAP-7 [S]** SHALL cache resolved maps in Redis to avoid repeated R2 fetches.
- **FR-MAP-8 [S]** SHALL gracefully show the raw (minified) frame with a warning when no matching map is found, rather than failing the event.
- **FR-MAP-9 [S]** Map artifacts SHALL be purged from R2 when their release ages past retention (§5.11), and the uploader SHOULD skip re-uploading unchanged artifacts (dedupe by Debug ID/checksum) to save storage.
- **FR-MAP-10 [M]** Symbolication SHALL be **skipped when `platform !== javascript`** (e.g. PHP/Laravel frames are already resolved); these events proceed straight to grouping with their native frames intact.

### 5.6 Issue List & Triage (Dashboard)

- **FR-UI-1 [M]** SHALL show an **Issues list** with title, culprit, level, event count, users affected, first-seen, last-seen/age, environment, and assignee.
- **FR-UI-2 [M]** SHALL support filtering by **environment** ("All Envs"), status, time range ("Since First Seen"), and free-text/tag search ("Filter events…").
- **FR-UI-3 [M]** SHALL support sorting (last seen, first seen, frequency).
- **FR-UI-4 [M]** SHALL provide bulk & single actions: **Resolve**, **Archive/Ignore**, **Mute**, **Assign**, matching the reference UI's action bar.
- **FR-UI-5 [M]** The **Issue Detail** view SHALL show: error title/message, status, first-seen age, event navigation (event N of M), and a **Highlights** panel with `handled`, `level`, `transaction`, `url`, and `Trace ID` (linked).
- **FR-UI-6 [M]** SHALL show the full symbolicated **stack trace**, **breadcrumbs**, **tags**, **request**, **user**, and **device/OS/browser** context for the selected event.
- **FR-UI-7 [S]** Highlights SHALL be editable (choose which fields are pinned), mirroring the reference "Edit" affordance.
- **FR-UI-8 [M]** SHALL let a user open the linked **Replay** and **Trace** directly from the issue.

### 5.7 Distributed Tracing / Waterfall

- **FR-TRC-1 [M]** SHALL accept a `trace_id` (and span info) on events so related errors/operations share one trace (e.g. two errors under `bba7158e…d0375`).
- **FR-TRC-2 [M]** SHALL render a **trace waterfall**: spans as time-positioned bars with op/description, duration, and status, plus error markers on the timeline.
- **FR-TRC-3 [M]** SHALL show trace-level context: platform (Frontend), browser, OS, device, release/environment (`vercel-production`), and the list of Issues in the trace.
- **FR-TRC-4 [M]** From a span/error in the trace, SHALL link back to the corresponding Issue detail.
- **FR-TRC-5 [S]** SHALL sample traces (default `tracesSampleRate` low) to bound overhead and volume; errored traces SHOULD be retained preferentially.

### 5.8 Session Replay

> Session replay is the highest-cost feature (CPU, bandwidth, storage). Recording is provided by the **Sentry Replay integration** (rrweb-based); v1 configures it for **on-error capture** to protect Taskip's performance. It is the last item type to be implemented (FR-WRK-5).

- **FR-RPL-1 [M]** The Sentry Replay integration SHALL be configured in **on-error / buffered** mode (`replaysOnErrorSampleRate: 1.0`, `replaysSessionSampleRate ≈ 0`) so it keeps a rolling in-memory buffer and only sends on error — no continuous streaming by default. A low-rate continuous session sample is configurable **[S]**.
- **FR-RPL-2 [M]** Replay data arrives as `replay_event` + `replay_recording` envelope items; the ingest SHALL stream the (compressed) recording payload to **R2** and enqueue a pointer (per FR-ING-4), never buffering it in the request handler.
- **FR-RPL-3 [M]** Workers SHALL assemble replay segments into a playable recording linked to its Issue/event and `trace_id`, storing metadata in PostgreSQL and blobs in R2.
- **FR-RPL-4 [M]** Replay privacy SHALL default to safe: `maskAllText` and `maskAllInputs` on, plus configurable block/mask/ignore selectors so no sensitive Taskip data (billing, auth, inbox PII) is recorded.
- **FR-RPL-5 [M]** SHALL link the replay to its Issue/event and `trace_id`; the dashboard SHALL play it back with a timeline showing error markers (as in the reference replay bar).
- **FR-RPL-6 [M]** The replay player SHALL show meta: user (anonymous ok), SDK/platform, and time-ago.
- **FR-RPL-7 [S]** SHALL respect a per-project replay quota/sample cap to control storage cost, dropping excess cheaply.

### 5.9 Alerting & Notifications (AWS SES)

- **FR-ALR-1 [M]** SHALL send an email alert when a **new Issue** is created.
- **FR-ALR-2 [M]** SHALL send an alert when a **resolved Issue regresses**.
- **FR-ALR-3 [M]** SHALL support **frequency alerts** (e.g. issue seen > N times in M minutes / spike detection). **[S for spike]**
- **FR-ALR-4 [M]** SHALL **deduplicate and throttle** notifications (digest/rate-limit per issue and per project) so the team is never spammed — a first-class requirement.
- **FR-ALR-5 [M]** Alert rules SHALL be configurable per project (environment filter, level filter, recipients, channel = email in v1).
- **FR-ALR-6 [M]** Emails SHALL be sent via **AWS SES** using templated content: issue title, culprit, environment, count, first/last seen, and a deep link to the Issue.
- **FR-ALR-7 [S]** SHALL support snooze/mute of alerts for an issue for a chosen window.

### 5.10 Projects, Environments, Releases, Auth

- **FR-ADM-1 [M]** SHALL support multiple **projects**, each with its own public DSN key(s) and settings.
- **FR-ADM-2 [M]** SHALL support **environments** (e.g. `vercel-production`, `preview`, `development`) as a filterable dimension.
- **FR-ADM-3 [M]** SHALL support **releases** bound to source-map artifacts, and display the release on each event.
- **FR-ADM-4 [M]** SHALL authenticate dashboard users (email/password or SSO) and scope access to the organization's projects (role: admin / member).
- **FR-ADM-5 [M]** SHALL let admins **regenerate/revoke DSN keys** and secret upload tokens.
- **FR-ADM-6 [S]** SHALL provide a member management UI (invite, role, remove).

### 5.11 Data Retention & Housekeeping

- **FR-RET-1 [M]** SHALL enforce configurable **retention** (e.g. events 30 days, replays 14–30 days) and purge expired data from PostgreSQL and R2 to control cost.
- **FR-RET-2 [M]** SHALL cap raw event storage: store full detail for a bounded number of sample events per Issue and aggregate the rest (counts, time series), rather than storing every duplicate at full fidelity.
- **FR-RET-3 [S]** SHALL expose per-project usage stats (events/day, replay storage) so cost stays visible.

### 5.12 Source Control Integration (GitHub)

Taskip's source lives in GitHub, so a geniusDebug project SHALL be linkable to its repo to connect errors back to real code.

- **FR-GH-1 [M]** An admin SHALL connect GitHub via OAuth or a **GitHub App** installation and link a geniusDebug project to a repository (`org/repo` + default branch). Tokens/installation IDs are stored encrypted, server-side only.
- **FR-GH-2 [M]** Each **release** SHALL record its commit SHA and repo (from `VERCEL_GIT_COMMIT_SHA` / `GITHUB_SHA` at deploy), so events are tied to an exact commit.
- **FR-GH-3 [M]** Symbolicated in-app stack frames SHALL render a **deep link to GitHub** at the release's commit and exact line (`https://github.com/<org>/<repo>/blob/<sha>/<path>#L<line>`) — one click from the error to the code that threw it (e.g. `useInboxConversations.ts`).
- **FR-GH-4 [S]** geniusDebug SHALL be able to fetch **commit / blame** context for the crashing frame to surface **suspect commits** (the commit(s) that last touched those lines) and suggest an assignee.
- **FR-GH-5 [S]** The Issue view SHALL show **"first seen in release / commit"** and, when available, the commits deployed between last-good and first-bad releases (regression range).
- **FR-GH-6 [C]** From an Issue, a user MAY create a **GitHub Issue** pre-filled with the error title, culprit, stack link, and geniusDebug deep link.
- **FR-GH-7 [C]** geniusDebug MAY auto-resolve an Issue when a commit/PR message references it (e.g. `fixes GENIUS-123`) — deferred but designed-for.
- **FR-GH-8 [M]** The GitHub token SHALL be least-privilege (read-only repo contents/metadata for v1) and revocable from the dashboard; loss of the token degrades gracefully (frames still show, just without live GitHub links/blame).

---

## 6. Non-Functional Requirements

### 6.1 Performance — "must not affect the main application" (top priority)
This is the project's defining constraint. The following are hard requirements:

> Since capture is the stock `@sentry/nextjs` SDK, most of these are met by **configuring it correctly and constraining it**, not by writing capture code. The SDK is already async/non-blocking and self-contained; our job is sampling, masking, bundle discipline, the kill switch, and keeping the backend isolated.

- **NFR-PERF-1** Client overhead SHALL be kept negligible via conservative config: tracing sampled low, Replay in on-error mode, and unused integrations removed. Enabling geniusDebug MUST NOT regress Taskip's Core Web Vitals beyond an agreed threshold (verified against a baseline — §9).
- **NFR-PERF-2** Replay (the SDK's rrweb integration) SHALL run in on-error/buffered mode so continuous recording cost is avoided; it MUST NOT cause visible jank in normal use.
- **NFR-PERF-3** The Sentry SDK's built-in "never break the host app" behavior SHALL be relied on (internal errors are swallowed); Taskip integration code (boundaries, tunnel route) MUST likewise never throw into the app.
- **NFR-PERF-4** The **remote kill switch** (FR-SDK-8) MUST allow disabling or throttling geniusDebug in Taskip **without a redeploy**, as the primary safeguard for this constraint.
- **NFR-PERF-5** geniusDebug backend runs on **separate infrastructure**; it MUST NOT share a database, Redis, or compute with Taskip.
- **NFR-PERF-6** Ingest endpoint p95 server processing time < 25 ms; it does no heavy envelope parsing inline (deferred to workers).
- **NFR-PERF-7** The added client bundle from `@sentry/nextjs` (with only the used integrations) SHALL be measured against a CI budget; Replay loaded so it does not bloat the initial bundle.
- **NFR-PERF-8** If geniusDebug is fully **down or unreachable**, Taskip's behavior and performance MUST be unchanged — the SDK drops/queues locally and the tunnel route fails fast without blocking the app.

### 6.2 Scalability
- **NFR-SCALE-1** Ingest and workers scale horizontally and statelessly.
- **NFR-SCALE-2** The queue absorbs spikes; sustained overload sheds low-value data first (§5.3 FR-WRK-4).
- **NFR-SCALE-3** PostgreSQL event/time-series tables SHALL be partitioned (e.g. by time) and indexed for the list/detail/filter queries; heavy blob data lives in R2, not PostgreSQL.

### 6.3 Reliability & Availability
- **NFR-REL-1** At-least-once processing with idempotency; poison messages go to a dead-letter queue and never block the pipeline.
- **NFR-REL-2** Target dashboard/API availability 99.5%; ingest availability is decoupled from dashboard.
- **NFR-REL-3** No data loss between ingest `202` and persistence under normal operation (durable queue).

### 6.4 Security & Privacy
- **NFR-SEC-1** Public DSN keys are **write-only** and cannot read data; read access requires authenticated dashboard sessions.
- **NFR-SEC-2** Source-map upload uses a **secret** org token, never the public DSN.
- **NFR-SEC-3** PII scrubbing at the SDK (default masking of inputs) and server-side denylist; replays mask text by default.
- **NFR-SEC-4** All transport over HTTPS/TLS; R2 access via short-lived presigned URLs scoped to a project.
- **NFR-SEC-5** Secrets (SES, R2, DB, **GitHub tokens/app keys**) held in a secrets manager/env, never in the client bundle; GitHub tokens stored encrypted at rest and least-privilege (read-only for v1).
- **NFR-SEC-6** Role-based access (admin/member) scoped to the organization; only admins can link/unlink GitHub and manage tokens.

### 6.5 Maintainability & Observability
- **NFR-MNT-1** Monorepo-friendly TypeScript across SDK, backend, and dashboard; shared types for the event schema.
- **NFR-MNT-2** geniusDebug SHALL emit its own internal metrics (queue depth, processing latency, ingest rate, drop counts) and health checks.
- **NFR-MNT-3** Versioned event schema so SDK and backend can evolve compatibly.

### 6.6 Usability
- **NFR-USE-1** Dashboard is responsive, keyboard-navigable, and loads an issue's detail (incl. highlights) in < 1 s for cached data.
- **NFR-USE-2** UI parity with the referenced Sentry views the team already knows (Issues, Highlights, Replay, Trace) to minimize retraining.
- **NFR-USE-3** The dashboard SHALL implement the design system in `docs/frontend-design-brief.md` (tokens, shell, component states, light+dark) and use the brand assets in `brand/` — icon, favicon (`geniusDebug — Issues` tab), and wordmark. Components MUST use the token scale, not hardcoded hex, so the UI stays one system with the brand mark.

---

## 7. Data Model (PostgreSQL via Drizzle ORM — logical)

Blobs (replay segments, source maps, attachments) live in **R2**; PostgreSQL stores metadata + pointers (R2 keys). JSON columns are `jsonb`. Schema is defined in **Drizzle** and migrated with `drizzle-kit`; the `events` table is **time-partitioned** (declared in a hand-authored migration on top of the Drizzle-generated table).

**organizations** — `id, name, created_at`

**users** — `id, org_id, email, password_hash, name, created_at`

**memberships** — `id, org_id, user_id, role(admin|member)`

**projects** — `id, org_id, name, slug, platform(e.g. javascript-nextjs | php-laravel), created_at`

**dsn_keys** — `id, project_id, public_key, is_active, rate_limit, created_at, revoked_at` *(write-only ingest key)*

**org_tokens** — `id, org_id, token_hash, scope(source-map-upload), created_at` *(secret, for CI/deploy uploader)*

**environments** — `id, project_id, name(vercel-production|preview|…)`

**repositories** — `id, project_id, provider(github), owner, name, default_branch, installation_id|token_ref(encrypted), connected_by_user_id, created_at` *(GitHub link — §5.12)*

**releases** — `id, project_id, version, commit_sha, repository_id, created_at` *(source maps bound here; commit ties to GitHub)*

**source_map_artifacts** — `id, release_id, project_id, debug_id, artifact_url, r2_key, checksum, size, created_at`
> Indexes: `(project_id, debug_id)` for symbolication lookup; `debug_id` is the primary match key.

**issues** — `id, project_id, short_id(JAVASCRIPT-NEXTJS-Z), fingerprint(unique per project), title, culprit, type(TypeError), level, status(unresolved|resolved|archived|muted), is_regressed, assignee_user_id, first_seen, last_seen, times_seen, users_affected, created_at`
> Indexes: `(project_id, status, last_seen)`, `(project_id, fingerprint)` unique, `(project_id, first_seen)`.

**events** — `id(event_id uuid), issue_id, project_id, environment_id, release_id, timestamp, level, handled(bool), transaction('/:workspace/dashboard'), url, message, exception jsonb(type,value,stacktrace), contexts jsonb(browser,os,device), request jsonb, user jsonb, tags jsonb, breadcrumbs jsonb, sdk jsonb, trace_id, span_id, replay_id`
> Partitioned by `timestamp` (e.g. daily/weekly). Indexes: `(issue_id, timestamp)`, `(project_id, timestamp)`, `(trace_id)`, `(replay_id)`.
> `replay_id` (GD-197) comes from `contexts.replay.replay_id` on the event — present whenever a replay session was active, independent of trace sampling. It's the primary error↔replay correlator; `trace_id` matching (below) is a fallback since Replay's `trace_ids` only include *sampled* transactions, which is empty most of the time at `tracesSampleRate < 1`.

**issue_counts** *(aggregate/time-series)* — `issue_id, bucket(time), count` *(so we don't store every duplicate event at full fidelity — FR-RET-2)*

**traces** — `trace_id, project_id, root_transaction, start_ts, end_ts, environment_id, release_id, platform`

**spans** — `id(span_id), trace_id, parent_span_id, op, description, start_ts, end_ts, duration_ms, status`

**replays** — `id(replay_id), project_id, issue_id, event_id, trace_id, user jsonb, started_at, duration_ms, segment_count, r2_prefix, size, created_at`
> Indexes: `(issue_id)`, `(trace_id)`.

**alert_rules** — `id, project_id, name, conditions jsonb(new|regression|frequency), environment_filter, level_filter, recipients jsonb, channel(email), throttle_window, is_active`

**notifications** — `id, project_id, issue_id, rule_id, sent_at, channel, status, dedupe_key`

**issue_activity** — `id, issue_id, user_id, action(resolve|archive|mute|assign|comment|regressed), payload jsonb, created_at` *(audit trail for triage)*

---

## 8. Deployment & Operations

- **Services:** `ingest` (autoscaled, stateless), `workers` (autoscaled), `api` (dashboard backend), `web` (React SPA/CDN).
- **Datastores:** PostgreSQL (managed), Redis (managed, for queue + rate limits + map cache), R2 (blobs).
- **CI hook (automatic):** on every deploy, the geniusDebug uploader runs in the build (Vercel post-build step or GitHub Actions): injects Debug IDs, **uploads source maps directly to Cloudflare R2**, registers the artifact index + commit/repo with geniusDebug, and strips maps from public output. `release = VERCEL_GIT_COMMIT_SHA`. Sentry's own SaaS upload is disabled (§5.1a). No manual step.
- **GitHub:** the project is linked to its GitHub repo (App/OAuth) so stack frames deep-link to source at the deployed commit (§5.12).
- **Config:** all secrets via env/secret manager; SES + R2 credentials server-side only.
- **Backups:** PostgreSQL PITR; R2 lifecycle rules aligned to retention (§5.11).

---

## 9. Acceptance Criteria (v1 "done" for the reference incident)
geniusDebug v1 is accepted when, for a Taskip production error like the reference incident, a developer can:

1. See a grouped **Issue** `Cannot read properties of undefined (reading 'json')` with short ID, count, first/last seen, and status controls (resolve/archive/mute).
2. Open an event and read a **symbolicated** stack pointing to `./stores/inbox/useInboxConversations.ts` with source context — from maps that were **uploaded to R2 automatically** by the deploy, with no manual step.
2b. Click a stack frame and land on the **exact line in GitHub** at the deployed commit.
3. See **Highlights**: handled, level, transaction `/:workspace/dashboard`, url, and a linked **Trace ID**.
4. Open the **trace waterfall** and see the related error(s) and spans with device/env context.
5. Watch the **session replay** of the moments before the crash, with sensitive fields masked.
6. Have received an **email alert** for the new issue, without duplicate spam.
7. Confirm that enabling the SDK caused **no measurable regression** in Taskip's Core Web Vitals (verified against a baseline).

---

## 10. Out of Scope (v1) / Future

Not in v1 (candidate for later): mobile SDKs, other server SDKs (NestJS `@sentry/node`, Python); log management; performance/APM dashboards and web-vitals product; cron/uptime monitors; user-feedback widget; Slack/Teams/PagerDuty channels; AI root-cause ("Ask Seer"-style) suggestions; SSO/SAML; multi-org billing & quotas UI; anomaly-based alerting beyond simple frequency; full-text event search engine.

**Design keeps the door open:** because the ingest speaks the **Sentry envelope protocol** and the pipeline is platform-agnostic (FR-WRK-7), other Sentry SDKs can be added later as pure client-config work — **Laravel/PHP is the first, planned for v2 (§12)**, and `@sentry/node`, React Native, or Python could follow the same way with no backend redesign.

**Build-vs-reuse decision (recorded):** v1 **reuses `@sentry/nextjs`** rather than building a browser SDK. Rationale: cross-browser capture, stack parsing, and replay recording are the hardest, riskiest parts of an error monitor and are already solved by a mature MIT-licensed SDK; reusing it lets the team focus on ingest, processing, and dashboard. Trade-off: geniusDebug inherits Sentry's payload/envelope shape (treated as a pinned contract) and must track SDK major upgrades. A fully independent SDK remains possible later without changing the backend.

---

## 11. Open Questions
1. `@sentry/nextjs` version to pin for v1, and the cadence/policy for reviewing upgrades (each may change the envelope payload the ingest parses).
2. Which envelope item types to support in the MVP milestone — `event` only first, then `transaction`, then replay? (Recommended.)
3. Continuous replay sampling — is on-error only sufficient for v1, or is a small continuous sample needed? (Default: on-error only.)
4. Retention windows — confirm event (30 d?) and replay (14 d?) defaults given R2 cost.
5. Auth for dashboard — email/password only in v1, or reuse Taskip/Xgenious SSO?
6. Expected peak event volume from Taskip (drives ingest/worker sizing and quotas).
7. Trace instrumentation depth — Sentry's default auto-instrumentation (navigation/`fetch`) only, or also custom spans?
8. Confirm `@sentry/nextjs` MIT license is cleared for self-hosted-backend use by the team.
9. Deploy model for the source-map uploader — does Taskip deploy via **Vercel's Git integration** (uploader runs as a Vercel post-build step) or via **GitHub Actions** (uploader runs in the workflow)? Affects where R2 credentials live.
10. GitHub connection method — a shared **GitHub App** (better for multi-repo, fine-grained perms) vs. a personal/OAuth token for v1?
11. Suspect-commit/blame depth (FR-GH-4/5) — in v1, or defer and ship only repo linking + frame deep links first?
12. v2 timing — when is the Laravel/PHP service expected to onboard (drives when §12 work is scheduled)?

---

## 12. Roadmap — v2 (Laravel / PHP support)

Deferred from v1. Reusing **`sentry/sentry-laravel`** against the existing envelope ingest; no backend redesign because v1 already ships FR-WRK-7 (platform-agnostic pipeline) and FR-MAP-10 (skip symbolication for non-JS). These become active work in v2:

- **FR-PHP-1 [v2]** Point a Laravel service at geniusDebug via `SENTRY_LARAVEL_DSN` (or `SENTRY_DSN`) = a geniusDebug project DSN. No other Sentry endpoint.
- **FR-PHP-2 [v2]** Ingest accepts its `event` (exceptions) and `transaction` (tracing) items via the **same** endpoint/parsing as the frontend (already handled by FR-WRK-5).
- **FR-PHP-3 [v2]** Verify grouping/culprit/Issue rendering on `platform: "php"` events with PHP stack frames (exercises FR-WRK-7 end-to-end).
- **FR-PHP-4 [v2]** Confirm the source-map step is skipped for PHP (FR-MAP-10); the R2 uploader stays a browser-only concern.
- **FR-PHP-5 [v2]** No session replay / no tunnel route for Laravel (browser-only); Laravel sends server-to-server directly to the ingest host.
- **FR-PHP-6 [v2]** Set the Laravel SDK `release` to the git commit SHA and link the repo so PHP frames deep-link to GitHub source (reuses §5.12).
- **FR-PHP-7 [v2]** Honor "must not affect the main app" in PHP's synchronous model: conservative `traces_sample_rate` and send events in the after-response/terminating phase (or queued), never in the user's request path.
- **FR-PHP-8 [v2]** Pin the `sentry/sentry-laravel` major version; treat its envelope output as part of the same pinned contract.

Other candidate platforms (same mechanism, later): `@sentry/node` for a NestJS/Node service, React Native for mobile, Python. Each is client-config + verification, not new protocol work.

---

*End of SRS v1.5 — finalized v1 build specification.*
