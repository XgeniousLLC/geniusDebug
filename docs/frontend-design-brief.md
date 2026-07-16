# geniusDebug — Frontend Design Brief & Prompt

> **Purpose.** This document is (1) the design specification for the geniusDebug dashboard and (2) a prompt you can hand to a design tool. It defines the design system and **every page** in enough detail that, when you later share a design URL (a Figma file, a live page, or a Sentry screen you want to mirror), it can be **mapped back to this brief and to the SRS** so the implemented UI keeps exactly the same design principles and covers the right requirements.
>
> Authoritative behavior spec: **`geniusDebug-SRS.md`**. Every screen below lists the SRS requirement IDs it satisfies. If a shared design conflicts with the SRS, the SRS wins on *behavior/data*; the shared design wins on *visual style* — reconcile using §12 (Mapping Protocol).

---

## 1. Design principles

1. **Information-first, calm.** This is a triage tool developers stare at during incidents. Dense but legible; neutral surfaces; a single accent color; color reserved to carry *meaning* (severity/status), not decoration.
2. **Scannable lists, deep details.** The Issues feed must be scannable at a glance (title, culprit, counts, age). Detail views can be dense and tabbed.
3. **Code is first-class.** Stack frames, IDs (event/trace/debug), payloads — all monospace, copyable, with clear in-app vs framework distinction.
4. **Light + dark, equal quality.** Dark is the default for a monitoring tool; both must be first-class and use the same token system.
5. **Fast + keyboard-friendly.** Sub-second issue detail load (cached). Keyboard nav for the feed (j/k, e=resolve, a=assign). No layout shift.
6. **Consistent system.** One component library, one spacing scale, one set of severity/status colors used everywhere.

---

## 2. Design tokens

> **Palette is now locked to the brand mark.** The values below are confirmed by the **geniusDebug icon** (Claude Design project "Frontend design brief", `geniusDebug Icon.dc.html`), implemented in `brand/` (see §2.0). These are the source of truth — do not drift from them. Never hardcode hex in components; map these to Tailwind theme tokens.

### 2.0 Brand mark (source of truth)

The geniusDebug icon defines the identity and confirms the core palette. Concept: a monitoring **scope** (ring) watching a **live signal** (EKG pulse), with the caught **error** as a red dot.

- **Tile gradient:** `accent` **#6C5FC7 → #7B2CBF** `level-fatal` (top-left → bottom-right) — the same accent + fatal tokens used across the UI.
- **Pulse:** white on the tile; **red dot:** `level-error` **#E5484D** (the one semantic color in the mark).
- **Dark surfaces in the mark** (`#0E0E14` bg, `#17171F` surface, `#2A2A36` border, `#EDEDF2`/`#9A9AA8`/`#6B6B78` text) — identical to the neutral tokens below.
- **Fonts:** Inter (UI) + JetBrains Mono (code/IDs) — same as §2 typography.
- **Assets & variants** (primary / favicon / monochrome / glyph, sizes 128→16, wordmark): `brand/` + `brand/GeniusDebugIcon.tsx`; see `brand/README.md`.
- **Favicon / tab:** use `brand/favicon.svg` (ring dropped at ≤16px); tab title **"geniusDebug — Issues"** (ties to §3 shell and §6 onboarding).

Because the icon and this token table are the same palette, a design implemented to this brief automatically matches the brand.

### Color — neutrals (surfaces & text)
| Role | Light | Dark |
|---|---|---|
| `bg` (app background) | `#FFFFFF` | `#0E0E14` |
| `surface` (cards, panels) | `#F7F7FA` | `#17171F` |
| `surface-2` (raised/hover) | `#EFEFF4` | `#1E1E28` |
| `border` | `#E3E3EA` | `#2A2A36` |
| `text` (primary) | `#1A1A22` | `#EDEDF2` |
| `text-muted` (secondary) | `#6B6B78` | `#9A9AA8` |
| `text-faint` (tertiary) | `#9A9AA8` | `#6B6B78` |

### Color — accent & semantics
| Role | Value | Use |
|---|---|---|
| `accent` | `#6C5FC7` (violet) | primary buttons, active nav, links, focus ring |
| `accent-strong` | `#584AB0` | hover/pressed |
| `level-fatal` | `#7B2CBF` | fatal |
| `level-error` | `#E5484D` (red) | error (default level) |
| `level-warning` | `#F5A623` (amber) | warning |
| `level-info` | `#4C82F7` (blue) | info |
| `level-debug` | `#8A8A98` (grey) | debug |
| `status-unresolved` | `#E5484D` | new/ongoing issue |
| `status-resolved` | `#30A46C` (green) | resolved |
| `status-muted` / `archived` | `#8A8A98` | muted / archived / ignored |
| `regressed` | `#F5A623` | regression flag |

### Typography
- **UI font:** Inter (or system UI stack). **Mono:** JetBrains Mono / ui-monospace for code, stack frames, IDs.
- Scale (px / line-height): `display 24/32`, `h1 20/28`, `h2 16/24`, `body 14/20` (default), `small 13/18`, `caption 12/16`, `mono 13/20`.
- Weights: 400 body, 500 medium (labels), 600 semibold (headings/emphasis).

### Spacing, radius, elevation
- **Spacing scale (px):** 2, 4, 8, 12, 16, 20, 24, 32, 40, 48. Base rhythm = 8.
- **Radius:** `sm 4`, `md 6` (default controls/cards), `lg 10` (modals), `full` (pills/avatars).
- **Elevation:** flat by default; `shadow-sm` for popovers/menus, `shadow-md` for modals. Prefer borders over shadows in dark mode.

### Motion
- 120–160 ms ease-out for hovers/menus; 200 ms for panel/drawer open. No gratuitous animation. Respect `prefers-reduced-motion`.

---

## 3. Global shell (app chrome)

Present on all authenticated pages. **SRS:** FR-ADM-1/2/4, FR-UI-2.

- **Left sidebar (collapsible, ~220px):**
  - Top: **Org / Project switcher** (dropdown; shows current project, search, "New project").
  - Primary nav: **Issues** (default), **Traces**, **Replays**, **Alerts**, **Settings**. Active item uses `accent` left-border + tint.
  - Bottom: user avatar → account menu (profile, theme toggle, sign out).
- **Top bar:**
  - **Environment selector** ("All Envs" ▾ — `vercel-production`, `preview`, `development`) — global filter, persists across pages. (FR-UI-2, FR-ADM-2)
  - **Global search** (⌘K) — jump to issue by short ID / text / trace ID.
  - **Time range** control where relevant ("Since First Seen", 24h, 7d, 14d, 30d, custom).
- **Content area:** page-specific. Breadcrumbs on detail pages (`Issues / Issue Details / <short-id>`).
- **Density:** comfortable default with a compact toggle for the feed.

---

## 4. Component library (shared)

Define once; reuse everywhere. **SRS:** FR-UI-*, FR-GRP-3.

- **Buttons:** primary (accent), secondary (surface + border), ghost, danger. Split-button (e.g. **Resolve ▾**) matching the reference action bar. Sizes sm/md.
- **Level pill:** small colored dot + label (error/warning/info/…), using `level-*` tokens.
- **Status chip:** unresolved / resolved / muted / archived, with `status-*` tokens; regressed shows an amber "regressed" tag.
- **Tag/badge:** key-value chips (`browser:chrome`, `os:android`, `release:ab12cd`), monospace value, clickable to filter.
- **Filter bar:** environment ▾, status ▾, time ▾, free-text search ("Filter events…"), saved searches. (FR-UI-2)
- **Data table / feed row:** selectable (checkbox), hover-raise, keyboard focus ring, bulk-action header.
- **Code block / stack frame:** monospace, line numbers, in-app frames highlighted vs collapsed framework frames, source-context lines around the crash line, **"Open in GitHub"** link per frame. Copy button. (FR-MAP-3/5/6, FR-GH-3)
- **ID chip:** monospace, truncated with copy (event/trace/debug IDs).
- **Tabs:** underline style for detail sub-sections.
- **Waterfall/timeline:** horizontal time-positioned bars (spans), error markers, playhead (replay). (FR-TRC-2, FR-RPL-5)
- **Key-value panel ("Highlights"):** two-column, editable pin set. (FR-UI-5/7)
- **States:** every list/detail has explicit **loading (skeleton)**, **empty**, and **error** variants (see §11).
- **Toast** (transient confirmations), **Modal** (destructive confirms, rule editor), **Drawer** (side detail, e.g. trace error panel), **Dropdown menu**, **Tooltip**.
- **Copy affordance:** any ID/URL/code is one-click copyable.

---

## 5. Page — Authentication

**Routes:** `/login`, `/signup`, `/forgot`, `/reset`. **SRS:** FR-ADM-4, NFR-SEC-6.

- Centered card on a plain branded background. Logo, product name.
- **Login:** email, password, "Forgot password?", submit (accent), error state for bad creds. (If SSO is chosen later — open question — add an SSO button above the divider.)
- **Signup:** name, email, password (strength hint), org creation on first user.
- **Forgot/Reset:** email entry → confirmation; reset via tokenized link.
- States: field validation inline, submit loading, auth error banner.
- Minimal chrome (no sidebar). Fully responsive/mobile.

---

## 6. Page — Onboarding / Create Project

**Route:** `/projects/new` (and post-signup). **SRS:** FR-ADM-1, FR-SDK-1..6, FR-BLD-1/2, FR-GH-1.

Purpose: create a project, show its DSN, and give copy-paste install instructions so Taskip starts sending events.

- **Step 1 — Create project:** name, platform (Next.js selected; others greyed/"coming soon" for Laravel v2), environment defaults.
- **Step 2 — Install `@sentry/nextjs`:** copyable code blocks:
  - `Sentry.init` config with the project **DSN** (pointed at geniusDebug), `tunnelRoute: '/monitoring'`, `environment`, `release`, sampling defaults, replay-on-error.
  - `next.config.js` `withSentryConfig` with Sentry upload disabled.
  - The build command with the source-map uploader.
- **Step 3 — Connect GitHub (optional):** "Connect repository" → GitHub App install flow; on return, pick the repo. (FR-GH-1)
- **Step 4 — "Waiting for first event…":** live poller that flips to success when the first event arrives (verifies the loop end-to-end).
- Show the **secret upload token** once (copy, with a "store this safely" warning) and the **public DSN** (safe to embed).
- States: pre-first-event waiting animation; success confirmation → "View issues".

---

## 7. Page — Issues (the main feed)  ★ primary screen

**Route:** `/issues` (default landing). **SRS:** FR-UI-1/2/3/4, FR-GRP-1..5, FR-ALR (entry points).

The reference screen. A scannable list of grouped issues with triage actions.

- **Header:** title "Issues", **filter bar** (environment ▾, status ▾ [Unresolved default], time ▾ "Since First Seen", free-text "Filter events…"), sort ▾ (Last Seen / First Seen / Events / Users), density toggle, saved searches.
- **Bulk action bar** (appears on selection): **Resolve ▾**, **Archive ▾**, **Mute**, **Assign**, matching the reference action row. (FR-UI-4)
- **Issue row** (each = one grouped Issue):
  - Checkbox · **level pill** · **title** (bold, e.g. *Cannot read properties of undefined (reading 'json')*) · **culprit** (muted mono, e.g. `./stores/inbox/useInboxConversations.ts`) · **short ID** (`JAVASCRIPT-NEXTJS-Z`).
  - Right-aligned metrics: **events count**, **users affected**, **age / last seen** ("13 minutes"), tiny **frequency sparkline**, assignee avatar.
  - Status chip; "New" / "regressed" (amber) badges. (FR-GRP-4/5)
  - Hover → quick actions (resolve, assign, mute); click → Issue Detail.
- **Left rail (optional):** saved searches / environments / assigned-to-me.
- **Pagination:** infinite scroll or cursor pages; show total.
- States: **empty** ("No issues 🎉 / waiting for events"), **loading** (row skeletons), **error** (retry).
- Mobile: collapses to a stacked card list (title, culprit, count, age); filters in a sheet.

---

## 8. Page — Issue Detail  ★

**Route:** `/issues/:shortId`. **SRS:** FR-UI-5/6/8, FR-GRP-3, FR-MAP-2..6, FR-GH-3, FR-TRC-1, FR-RPL-5.

- **Header:** breadcrumb (`Issues / Issue Details / <short-id>`); **title** + level; **culprit**; **first-seen age**; **event navigation** ("Event 1 of N", prev/next); action bar: **Resolve ▾**, **Archive ▾**, **Mute (bell)**, **Share/Assign**, overflow (…). (FR-UI-5)
- **Highlights panel** (pinned key-values, editable): **handled** (yes/no), **level**, **transaction** (`/:workspace/dashboard`), **url** (link), **Trace ID** (link → Trace view). "Edit" affordance to choose pinned fields. (FR-UI-5/7)
- **Tabs / sections:**
  - **Stack trace** — symbolicated frames, in-app highlighted, framework frames collapsed, **source context** lines, **"Open in GitHub"** per frame (exact commit + line). Raw-frame fallback + warning if no map. (FR-MAP-2..6, FR-GH-3)
  - **Breadcrumbs** — chronological trail (clicks, navigations, fetch/XHR, console) leading to the error. (from SDK)
  - **Tags** — filterable chips (browser Chrome Mobile 150, os Android 10, device, release, environment `vercel-production`). (FR-UI-6)
  - **Context** — request, user (workspace/tenant), device/OS/browser. (FR-UI-6)
  - **All Events** — table of individual occurrences.
- **Right rail / cards:**
  - **Session Replay** preview → "See Full Replay" (→ Replay page). (FR-UI-8, FR-RPL-5)
  - **Trace** mini-view → open Trace. (FR-TRC-1)
  - **Suspect commit / suggested assignee** (if GitHub blame enabled — v2-ish). (FR-GH-4)
  - Occurrence chart over time; first/last seen; times seen; users affected.
- **Activity** — audit trail (resolved by, assigned, regressed, comments). (issue_activity)
- States: loading skeleton; "no replay for this event"; "source map missing" warning inline.

---

## 9. Page — Trace / Waterfall

**Route:** `/traces/:traceId`. **SRS:** FR-TRC-1..5.

- **Header:** "Trace" + the error summary + trace ID; meta row: platform (Frontend), browser, OS, device, release/env (`vercel-production`), age; **"Open in Explore"**; count of issues in the trace. (FR-TRC-3)
- **Waterfall:** left = span tree (op/description, indented by parent); right = **time-positioned bars** with duration, status color, and **error markers** on the timeline. Time axis (0–Nms). (FR-TRC-2)
- **Search in trace** input; select a span → **side drawer** with span/error details, linking back to the Issue. (FR-TRC-4)
- States: single-span traces, errored spans emphasized (red), loading skeleton bars.
- This mirrors the provided Sentry trace screenshot — treat that as the visual reference.

---

## 10. Page — Session Replay

**Route:** `/replays/:replayId` (and embedded preview on Issue Detail). **SRS:** FR-RPL-1..6.

- **Player:** DOM playback canvas; **transport bar** (play/pause, scrubber, speed), **timeline with error markers** and breadcrumb ticks (matching the reference replay bar). Fullscreen. (FR-RPL-5)
- **Meta:** user (anonymous ok), SDK/platform (javascript-nextjs), time-ago, duration. (FR-RPL-6)
- **Side panel:** synchronized breadcrumbs/console/network for the current playhead; clicking a breadcrumb seeks.
- **Privacy:** masked inputs/text render as masked blocks (make masking visible so it's clearly safe). (FR-RPL-4)
- **Replays list** (`/replays`): table (user, project, duration, error count, time). (FR-UI, FR-RPL)
- States: "replay still processing", "no replay", buffering.

---

## 11. Page — Alerts

**Routes:** `/alerts` (rules list), `/alerts/new`, `/alerts/:id`. **SRS:** FR-ALR-1..7.

- **Rules list:** name, conditions (new issue / regression / frequency), environment & level filters, recipients, channel (Email), active toggle. (FR-ALR-5)
- **Rule editor:** trigger type (new issue, regression, "seen > N times in M minutes"), environment/level filters, recipients (SES emails), **throttle/digest window** (emphasize — anti-spam is a first-class requirement), enable/disable. (FR-ALR-1..4)
- **Notification history:** sent alerts, dedupe key, status. (notifications table)
- States: empty ("no rules — create one"), test-send confirmation, throttled indicator.

---

## 12. Page — Settings

**Route:** `/settings/:projectId/*`. Left sub-nav within Settings. **SRS:** FR-ADM-1..6, FR-MAP-1/9, FR-GH-1..8, FR-RET-1..3, FR-SDK-8.

Sub-pages:
- **General** — project name, slug, platform, default environment; danger zone (delete project).
- **Client Keys (DSN)** — public DSN key(s), copy, regenerate/revoke, rate limit; the tunnel/`Sentry.init` snippet. (FR-ADM-5, FR-SDK-2/3)
- **Environments** — list/add environments; used as the global filter. (FR-ADM-2)
- **Releases** — releases with commit SHA + repo link, source-map artifact status per release ("maps uploaded ✓"). (FR-ADM-3, FR-MAP-1)
- **Source Maps** — upload status/health, secret **org upload token** (show-once, regenerate), retention of artifacts. (FR-MAP-1/9, §4.3)
- **GitHub Integration** — connect/disconnect repo, installation status, linked `org/repo` + default branch, permission scope note, "frame deep-links: on". (FR-GH-1/2/8)
- **Alerts defaults** — default recipients, global throttle.
- **Retention & Usage** — retention windows (events / replays), usage stats (events/day, replay storage) for cost visibility. (FR-RET-1/3)
- **Remote config / Kill switch** — toggle to disable/throttle geniusDebug in Taskip without a redeploy; sample-rate overrides. (FR-SDK-8, NFR-PERF-4) — surface this prominently; it's the safety control.
- States: token show-once modal, revoke confirm, "GitHub not connected" empty state.

---

## 13. Page — Team & Account

**Routes:** `/settings/members`, `/account`. **SRS:** FR-ADM-4/6, NFR-SEC-6.

- **Members:** list (name, email, role admin/member), invite, change role, remove. Admin-only actions gated. (FR-ADM-6)
- **Account:** profile (name, email, password change), **theme toggle** (light/dark/system), notification preferences, sessions/sign-out.
- States: pending invites, self-role-change guard.

---

## 14. Cross-cutting states & conventions

- **Loading:** skeletons that match final layout (no spinners for lists). Detail loads < 1s cached (NFR-USE-1).
- **Empty:** friendly, actionable ("No issues yet — here's your DSN / check your install").
- **Error:** inline card with retry; never a blank screen. Monitoring must not itself look broken.
- **Real-time:** the feed and issue counts update as new events arrive (poll or stream); show a subtle "N new" pill rather than jumping.
- **Permissions:** admin-only controls (keys, GitHub, members, delete) hidden/disabled for members.
- **Accessibility:** WCAG AA contrast in both themes; full keyboard nav; focus rings (accent); ARIA on interactive widgets; color never the sole signal (pair with icon/label for level/status).
- **Responsive:** three-column detail collapses to tabs on tablet; feed becomes cards on mobile; player adapts. Mobile is a *view/triage* experience, not full admin.

---

## 15. Mapping Protocol — reconciling a shared design URL to this brief + SRS

When a design URL (Figma, live page, or a Sentry screen to mirror) is shared later, follow this to keep principles identical and coverage correct:

1. **Identify the screen** → match it to a page in §5–§13 (by route/purpose). If it's new, add it here and flag the SRS gap.
2. **Extract tokens** from the design (colors, type, spacing, radius) → map each to the **roles** in §2. Adopt the design's *values*, keep our *roles/contrast*. Update §2 with the final brand values so everything stays one system.
3. **Inventory components** in the design → map to §4. Reuse existing component roles; only add new ones deliberately.
4. **Check data coverage** → for that screen, confirm every SRS field/action for its requirement IDs is present (e.g. Issue Detail must show handled/level/transaction/url/trace per FR-UI-5). Flag anything the design omits that the SRS requires, and anything the design adds that the SRS doesn't cover.
5. **Verify the golden principles** (§1) hold: information-first, meaning-carrying color, mono for code/IDs, light+dark parity, keyboard-friendly.
6. **Record the mapping** as a short table: `design screen → brief §/page → SRS IDs → deltas to resolve`.
7. **Resolve conflicts:** SRS wins on behavior/data; shared design wins on visual style. Note any exceptions.

Keep this brief and the SRS in sync: if a mapped design changes behavior, update the SRS; if it changes visuals, update §2/§4 here.
