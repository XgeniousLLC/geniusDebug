# AI Fix Suggester — Design Doc (NEXT STAGE)

> **Status: PLANNED / NOT BUILT.** This is a design for a future feature. It is
> parked while we stabilize the core pipeline (ingest → worker → issue → dashboard).
> Do not implement until the current bug-fix pass lands and the reference
> acceptance path (SRS §9) is green in production.

## Goal
For a given issue, produce an **AI-generated probable fix**: a short root-cause
explanation plus a concrete code change (diff or patch snippet), grounded in the
symbolicated stack trace **and the actual source file(s) pulled from the linked
GitHub repo**. Surfaced on Issue Detail as a "Suggested fix" card; optionally
opens a draft GitHub PR.

Non-goals (v1 of this feature): auto-merging, running the app, multi-file
refactors, guaranteeing correctness. It is an assistant, not an autofix.

## Why it fits geniusDebug
We already have the three inputs a good suggestion needs:
1. **Symbolicated error** — type, message, culprit, in-app frames with file/line
   (FR-MAP), breadcrumbs, tags, release/commit.
2. **GitHub App link** — repo owner/name + installation token + release commit
   (FR-GH-1/3), so we can fetch the exact source at the errored revision.
3. **Grouping context** — times_seen, first/last seen, regression range, suspect
   commits (FR-GH-4) → narrows what changed.

## Architecture (proposed)
New NestJS feature module in `apps/api` (`suggest/`) + a worker-side option for
async generation. Never on the ingest hot path.

```
Issue Detail  ──POST /issues/:shortId/suggest──►  SuggestController (admin/member)
                                                     │
                                                     ▼
                                              SuggestService
                                                 1. load issue + latest event (symbolicated frames)
                                                 2. resolve GitHub repo + installation token + commit sha
                                                 3. fetch relevant source windows from GitHub
                                                    (top N in-app frames: file @ sha, ±40 lines)
                                                 4. build grounded prompt
                                                 5. call Claude (Messages API)
                                                 6. parse → { rootCause, confidence, patch[], notes }
                                                 7. persist suggestion (cache by (issueId, latestEventId, model))
                                                     │
                                                     ▼
                                            fix_suggestions table  ──►  UI "Suggested fix" card
```

### Inputs assembled per suggestion
- **Error envelope:** exceptionType, value, level, handled, platform.
- **Stack (in-app first):** for each top frame — `filename:lineno:colno`, function,
  the symbolicated `context_line` + pre/post context we already store.
- **Source from GitHub:** for the top 1–3 in-app frames, fetch the file at the
  release commit (`GET /repos/{owner}/{repo}/contents/{path}?ref={sha}`, base64),
  slice a window around the errored line. Falls back to default branch if no
  release commit. Cap total fetched source (e.g. ≤ 1,500 lines) for token budget.
- **Change context (optional):** suspect commits touching the culprit file
  (reuse `commitsForFile`, FR-GH-4) + regression range if `is_regressed`.
- **Breadcrumbs / request / tags:** trimmed, last ~20 breadcrumbs.

### Prompt design (grounding + anti-hallucination)
- System: "You are a senior engineer. Diagnose the runtime error using ONLY the
  provided stack trace and source. If the cause is not determinable from the
  given files, say so and list what else you'd need. Never invent file paths or
  APIs not present in the source."
- User content blocks: error summary → stack (in-app) → each source file window
  (path + line-numbered) → change context.
- Force structured output (tool/JSON schema):
  ```jsonc
  {
    "rootCause": "string",
    "confidence": "high | medium | low",
    "explanation": "string (2–5 sentences)",
    "patches": [{ "path": "string", "unifiedDiff": "string" }],
    "testSuggestion": "string | null",
    "needMoreContext": ["string", ...]
  }
  ```
- Model: **`claude-opus-4-8`** for quality (async, cost acceptable); **`claude-sonnet-5`**
  for a cheaper fast tier. Selectable per org. Use prompt caching on the static
  system + source blocks when regenerating.

### Data model (Drizzle — new table, additive migration)
```
fix_suggestions
  id            uuid pk
  issue_id      uuid → issues(id)  (cascade)
  event_id      text                (the event the suggestion was grounded on)
  model         text
  root_cause    text
  confidence    text                (high|medium|low)
  explanation   text
  patches       jsonb               ([{path, unifiedDiff}])
  test_suggestion text null
  meta          jsonb               (token usage, source files fetched, sha)
  created_by    uuid → users(id) null
  created_at    timestamptz default now()
index (issue_id, created_at desc)
```
Cache/idempotency: if a suggestion exists for `(issue_id, event_id, model)`, return
it unless `?refresh=true`.

### API surface
- `POST /issues/:shortId/suggest` → generate (or return cached). Body: `{ model?, refresh? }`.
- `GET  /issues/:shortId/suggest` → latest suggestion for the issue.
- Access: project-scoped (reuse `assertProjectAccess`); generation may be
  admin-gated initially (cost control). Rate-limit per org/day.
- Later: `POST /issues/:shortId/suggest/pr` → open a draft PR from a chosen patch
  (needs GitHub App `contents: write` + `pull_requests: write` — a permission bump
  from today's read-only least-privilege; make it opt-in per repo).

### UI (Issue Detail)
- "Suggested fix" card under Suspect Commits: confidence badge, root cause,
  collapsible explanation, per-file diff (monospace, red/green), "Regenerate",
  and (later) "Open draft PR". Empty state: "Generate a fix suggestion" button.
- Show `needMoreContext` when confidence is low instead of a bad patch.

## Cost & safety
- **Cost discipline (golden rule 6):** on-demand only (no auto-generate on every
  issue), cache aggressively, cap source tokens, per-org daily quota, cheaper
  model tier option, prompt caching on regen.
- **Secrets (golden rule 5):** `ANTHROPIC_API_KEY` server-side only; store via the
  existing `integrations` table (AES-GCM, kind `anthropic`) so it configures in-app
  like R2/SES.
- **Never touch Taskip / never auto-apply:** suggestions are advisory; PR creation
  is explicit and draft-only.
- **Platform-agnostic (golden rule 4):** key off `platform`; the flow is generic
  (JS today, PHP/Laravel v2) — only symbolication differs upstream.
- **Guardrails:** strip secrets from source before sending (basic scan);
  truncate large files; refuse when no in-app frames / no repo linked.

## Phasing
1. **P1 — Diagnose (read-only):** assemble inputs, call Claude, structured output,
   persist + card. No GitHub write. ← start here when unparked.
2. **P2 — Grounded patches:** fetch source windows from GitHub at commit, produce
   unified diffs, per-file diff UI.
3. **P3 — Draft PR:** opt-in `contents/pull_requests: write`, open draft PR from a
   selected patch, link back to the issue.
4. **P4 — Feedback loop:** thumbs up/down on suggestions → store signal; use
   suspect-commit + regression range to sharpen prompts.

## Open questions (resolve before build)
- Per-org model/key config vs a single platform key + usage billing?
- Admin-only generation, or members too (with quota)?
- How much breadcrumb/replay context actually improves suggestions vs. cost?
- Multi-frame / multi-file windows — how many frames before token bloat hurts?

## Traceability
Extends: FR-MAP (symbolication), FR-GH-1/3/4/6 (repo link, suspect commits, issue
creation). New requirement IDs to be assigned (e.g. FR-AIF-*) when this leaves
PLANNED.
