# geniusDebug — Landing Page Context Brief

> **Purpose:** everything a frontend/design agent needs to build a public **promo + download** landing
> page for geniusDebug (in the style of Xgenious free-software pages). Self-contained — product facts,
> copy, brand kit, screenshot manifest, section wireframe, SEO, and the download flow. Hand this whole
> file to the agent.

---

## 1. Product snapshot

| Field | Value |
|---|---|
| **Name** | geniusDebug |
| **Category** | Self-hosted error & performance monitoring (open-source) |
| **One-liner** | A minimal, self-hosted Sentry alternative for frontend error monitoring. |
| **Elevator pitch** | Capture, group, and triage runtime errors from your web app — stack traces, source-mapped code locations, distributed traces, and short session replays — on your own infrastructure, without Sentry's cost or overkill. |
| **Positioning** | "Own the slice of Sentry you actually use." Not a full Sentry clone — the day-to-day 20% a small team lives in, self-hosted, no per-event/seat pricing. |
| **Maker** | Xgenious (free & open-source software line) |
| **Repo** | https://github.com/XgeniousLLC/geniusDebug |
| **Docs** | https://xgeniousllc.github.io/geniusDebug/ |
| **License** | **DECISION NEEDED** — recommend **MIT** to match Xgenious's other free software. No `LICENSE` file exists yet; add one before promoting as open-source. (It reuses `@sentry/nextjs`, which is MIT.) |

### Tagline options (pick one for the hero)
- "Self-hosted error monitoring. Without the Sentry bill."
- "Your errors, your servers, your rules."
- "The 20% of Sentry you actually use — self-hosted and free."
- "Catch, group, and fix frontend errors on your own infra."

---

## 2. Who it's for

- **Small-to-mid dev teams** running Next.js / React apps who find Sentry SaaS overkill or too expensive.
- **Agencies & product studios** who want error monitoring per client without per-seat pricing.
- **Privacy/compliance-conscious teams** who need error + replay data to stay on their own infra.
- **Self-hosters / homelab devs** who already run their own Postgres/Redis and want one more service.
- **Laravel/PHP teams** (v2) — the pipeline is already platform-agnostic.

---

## 3. Problem → value props (hero + "why" section)

| Value | Headline | Support copy |
|---|---|---|
| **Cost** | No per-event, per-replay, or per-seat pricing | Run it on a $12 VPS. Ingest as many events as your box handles. |
| **Fit** | Own the slice you use — no vendor lock-in | Reuses the standard Sentry SDK; point the DSN at your server. Leave anytime. |
| **Isolation** | Never slows down your app | Runs on separate infra; the SDK path is async and best-effort. If geniusDebug is down, your app is unaffected. |
| **Data ownership** | Your errors stay on your servers | Events, replays, and source maps live in your Postgres / your R2 bucket. |
| **Drop-in** | Works with your existing Sentry SDK | Already using `@sentry/nextjs`? Integration is a config change, not a rewrite. |

---

## 4. Core features (benefit-led — use as feature cards)

Suggested icon in parentheses (Material/Lucide names).

- **Error grouping** *(layers)* — Deduplicates errors into Issues with fingerprinting, short IDs, and automatic regression detection when a resolved issue comes back.
- **Symbolication** *(file-code)* — Maps minified stack frames back to your original file / line / function with source context, via Debug-ID source maps stored in R2.
- **GitHub integration** *(github)* — One-click App install (personal or org). Per-frame "Open in GitHub", suspect-commit detection, and auto-resolve when a commit says `fixes SHORT-ID`.
- **Distributed traces** *(git-fork / waterfall)* — Span waterfall with error markers, linked back to the issue that fired.
- **Session replay** *(play-circle)* — On-error, privacy-masked DOM replay with an error-marked timeline. See exactly what the user did.
- **Smart alerts** *(bell)* — New / regression / frequency (spike) rules with dedupe, throttle, and snooze. Email via AWS SES.
- **Fast triage UX** *(zap)* — Filters, sort, global search (⌘K), keyboard nav (j/k/e/x/↵), merge issues, assign to members, editable highlights.
- **Multi-project + roles** *(folder)* — Multiple projects, DSN keys (regenerate/revoke), members with roles, per-project access control.
- **Safety controls** *(shield)* — Remote kill switch (disable ingest with no redeploy), back-pressure shedding, dead-letter queue for poison events.
- **Built to scale cheaply** *(database)* — Time-partitioned events with auto-rolled monthly partitions and retention purges. Store full detail only for sample events.

---

## 5. How it works (4-part architecture — for a "How it works" diagram)

```
Your app (@sentry/nextjs)  →  Ingest  →  Redis queue  →  Workers  →  Postgres + R2  →  Dashboard
   sends Sentry envelopes      auth +      (BullMQ)       parse,        issues,           React SPA
   via its normal DSN          rate-limit                 symbolicate,  events,           triage UI
   + tunnelRoute               + enqueue                  group, alert  replays
```

1. **Client** — your app keeps the stock Sentry SDK; you just repoint the DSN (+ a tunnel route).
2. **Ingest** — a thin endpoint that authenticates, rate-limits, size-caps, and enqueues. Does no heavy work (stays fast so your app is never blocked).
3. **Workers** — consume the queue: normalize → symbolicate (JS) → fingerprint → group into issues → persist → evaluate alerts.
4. **Dashboard + API** — REST API + React SPA to triage everything.

---

## 6. Screenshot manifest

All 7 exist at **1440×860 PNG** in `docs/screenshots/`. Use for the gallery / feature sections. Ship
both light & dark if you recapture; current set is dark theme.

| File | Use as | Caption | Alt text |
|---|---|---|---|
| `docs/screenshots/issues.png` | Hero / gallery | Issues feed — grouped, triageable | geniusDebug issues list with grouped errors, filters, and status |
| `docs/screenshots/issue-detail.png` | Feature: symbolication | Issue detail — symbolicated stack, highlights, trace/replay, activity | geniusDebug issue detail showing a source-mapped stack trace |
| `docs/screenshots/trace.png` | Feature: traces | Trace waterfall | Distributed trace waterfall with span timings and error markers |
| `docs/screenshots/replay.png` | Feature: replay | Session replay (on-error, privacy-masked) | Session replay player with a timeline and masked inputs |
| `docs/screenshots/alerts.png` | Feature: alerts | Alert rules with dedupe/throttle & frequency triggers | Alert rules configuration screen |
| `docs/screenshots/settings.png` | Feature: admin | DSN, kill switch, GitHub App, members, retention, metrics | Project settings and integrations |
| `docs/screenshots/login.png` | Optional | First-time login / register | geniusDebug login screen |

**Best hero shot:** `issues.png` (most recognizable) or `issue-detail.png` (most impressive).

---

## 7. Tech stack + system requirements

**Stack:** NestJS · TypeScript · PostgreSQL (Drizzle ORM) · Redis (BullMQ) · Cloudflare R2 (S3-compatible)
· AWS SES · React + Zustand + Tailwind · reuses `@sentry/nextjs`.

**Requires (self-host):**
- Docker 24+ & Compose v2 — *or* Node 20 LTS + PostgreSQL 16 + Redis 7.
- ~2 GB RAM / 2 vCPU for a small team; ~20 GB disk.
- Optional (light up extra features): Cloudflare R2 (source maps + replays), AWS SES (email alerts), a GitHub App (source deep-links).

**Runs on:** any VPS (DigitalOcean, AWS EC2, Hetzner…), Coolify (Nixpacks), or Docker Compose.

---

## 8. What's included / the download

The download is the **full monorepo source** (self-host it). Contents:

- `apps/ingest` — envelope intake service
- `apps/api` — dashboard REST API
- `apps/workers` — processing pipeline
- `apps/web` — React dashboard SPA
- `packages/db`, `packages/shared` — schema + shared types
- `docker-compose.yml` + per-service Dockerfiles
- `docs/` — full documentation (also on the docs site)
- `taskip-integration/` — drop-in reference wiring for a Next.js app

**Download options for the page (pick one or offer both):**
1. **Source `.zip`** — `https://github.com/XgeniousLLC/geniusDebug/archive/refs/heads/main.zip` (always latest main).
2. **Tagged release `.zip`** — create a GitHub Release; link its zip asset (recommended for a stable "v1.0" download).
3. **`git clone`** — `git clone https://github.com/XgeniousLLC/geniusDebug.git`.

---

## 9. Quickstart (show on the page as a code block)

```bash
git clone https://github.com/XgeniousLLC/geniusDebug.git
cd geniusDebug
cp .env.example .env          # set JWT_SECRET, APP_ENCRYPTION_KEY, POSTGRES_PASSWORD
docker compose up -d --build  # postgres + redis + migrate + ingest + api + workers + web
# open http://localhost:8080 → create your admin account
```

Full guide: https://xgeniousllc.github.io/geniusDebug/deployment-guide.html

---

## 10. Comparison vs Sentry SaaS (table for the page)

| | geniusDebug | Sentry SaaS |
|---|---|---|
| Hosting | Your infra | Vendor cloud |
| Pricing | Free (your server costs only) | Per-event / replay / seat |
| Data ownership | 100% yours | Vendor-held |
| Error grouping + symbolication | ✅ | ✅ |
| Traces + on-error replay | ✅ | ✅ |
| GitHub deep-links + auto-resolve | ✅ | ✅ |
| SDK | Standard `@sentry/*` (unchanged) | Standard `@sentry/*` |
| Setup | Self-host (Docker / VPS) | Sign up |
| Scope | The core triage loop | Full platform |

---

## 11. FAQ (for the page)

- **Do I have to replace my Sentry SDK?** No. geniusDebug speaks the Sentry envelope protocol — keep `@sentry/nextjs` (or any Sentry SDK) and just repoint the DSN.
- **Will it slow down my app?** No. The SDK path is async/best-effort and gated by a remote kill switch; ingest only enqueues. If geniusDebug is down, your app is unaffected.
- **What does it cost?** The software is free/open-source; you pay only for the server you run it on.
- **Do I need Cloudflare R2 or AWS SES?** No — the core capture → group → triage loop works without them. R2 adds source-map symbolication + replay playback; SES adds email alerts.
- **Does it support Laravel / PHP?** The backend is platform-agnostic and already groups `platform:"php"` events; a first-class Laravel guide ships in v2.
- **Can I migrate off Sentry SaaS?** Yes — swap the DSN, disable Sentry's source-map upload, add geniusDebug's uploader to CI. No app code changes.
- **How do I get updates?** `git pull && docker compose up -d --build` (migrations are idempotent).

---

## 12. Brand kit

**Logo files** (in repo, ready to use):
- `docs/assets/logo-wordmark.svg` — icon + "geniusDebug" wordmark (use in nav / hero).
- `docs/assets/logo.svg` — icon only (gradient tile, 120×120).
- `docs/assets/favicon.svg` — favicon.

**Logo concept:** a monitoring *scope* (ring) watching a *live signal* (EKG/heartbeat pulse), with the caught *error* as a red dot on the pulse.

**Colors:**
| Token | Hex | Use |
|---|---|---|
| Accent (brand) | `#6C5FC7` | primary buttons, links, "genius" wordmark |
| Fatal (gradient end) | `#7B2CBF` | logo gradient, accents |
| Error red | `#E5484D` | the error dot, error states, urgency |
| Muted | `#9A9AA8` | "Debug" wordmark, secondary text |
| Dark bg | `#0E0E14` | dark sections |
| Light bg | `#FFFFFF` | light sections |

**Brand gradient:** `linear-gradient(135deg, #6C5FC7 → #7B2CBF)`.

**Typography:** system UI sans (Inter / -apple-system) for UI; **monospace** for code, stack frames, IDs, DSNs. Tight letter-spacing on headings (~ -0.02em).

**Tone:** technical, confident, no-BS. Developer audience — show real code and real screenshots. Avoid enterprise fluff. "Minimal", "self-hosted", "own your data", "no bill".

---

## 13. CTAs + download flow

**Primary CTA:** `Download geniusDebug` (→ the `.zip`, see §8) — or `Download .zip`.
**Secondary CTAs:** `View on GitHub`, `Read the docs`, `Live demo` *(only if a demo is hosted — see §17)*, `Quickstart`.

Suggested hero button pair: **[ Download .zip ]** (filled, brand gradient) + **[ View on GitHub ]** (outline).

Download-section pattern (mirrors Xgenious free-software pages): a card with the version, license, size,
"what's included" bullets, the big **Download .zip** button, and a `git clone` one-liner underneath.

---

## 14. SEO / meta

- **Title:** `geniusDebug — Free Self-Hosted Sentry Alternative for Error Monitoring`
- **Meta description:** `Open-source, self-hosted error monitoring for Next.js & React. Stack traces, source maps, traces, and session replays — reuse your Sentry SDK, no per-event pricing. Download free.`
- **Primary keywords:** self-hosted Sentry alternative, open-source error monitoring, self-hosted error tracking, free Sentry alternative, Next.js error monitoring, session replay self-hosted, source map symbolication.
- **OG image:** render `logo-wordmark.svg` on a `#0E0E14` bg, or use `issues.png`.
- **Structured data:** `SoftwareApplication` (applicationCategory: DeveloperApplication, offers: price 0, operatingSystem: Docker/Linux).

---

## 15. Links

- Repo: https://github.com/XgeniousLLC/geniusDebug
- Docs: https://xgeniousllc.github.io/geniusDebug/
- Deployment guide: https://xgeniousllc.github.io/geniusDebug/deployment-guide.html
- Integration guide: https://xgeniousllc.github.io/geniusDebug/integration.html
- Source zip: https://github.com/XgeniousLLC/geniusDebug/archive/refs/heads/main.zip

---

## 16. Suggested landing-page section order (wireframe)

1. **Nav** — wordmark logo · Features · Screenshots · Docs · GitHub · **Download** button.
2. **Hero** — headline (tagline §1) + subline (elevator pitch) + **[Download .zip] [View on GitHub]** + hero screenshot (`issues.png`).
3. **Trust strip** — "Reuses the standard Sentry SDK · Self-hosted · MIT · No per-event pricing".
4. **Why / value props** — 3–5 cards from §3 (Cost, Fit, Isolation, Data ownership, Drop-in).
5. **Features** — grid of feature cards from §4 with icons.
6. **Screenshots gallery** — carousel/tabs of the 7 shots from §6 with captions.
7. **How it works** — the 4-part diagram from §5.
8. **Comparison** — the vs-Sentry table from §10.
9. **Quickstart / Get started** — the code block from §9 + link to docs.
10. **System requirements** — from §7.
11. **Download** — the download card from §13 (version, license, size, includes, big button).
12. **FAQ** — from §11 (accordion).
13. **Footer** — Xgenious branding, links (§15), other free software, contact.

---

## 17. Open decisions (confirm before launch)

- [ ] **License** — add a `LICENSE` file (recommend MIT). Page claims "open-source/free" depend on it.
- [ ] **Live demo** — is there a public demo instance to link? If not, drop the "Live demo" CTA or record a short video/GIF instead.
- [ ] **Zip source** — latest-main zip vs a tagged release asset (recommend cutting a `v1.0` release for a stable download + changelog).
- [ ] **Screenshots** — current set is dark-theme only; recapture light-theme versions if the landing page is light.
- [ ] **Hosting** — where does the landing page live (xgenious.com/free-software/geniusdebug)? Confirm the canonical URL for SEO/OG.
