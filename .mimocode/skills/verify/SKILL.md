---
name: verify
description: Run full project verification — typecheck all workspaces, run test suite, build web. Use after any code change to confirm nothing is broken.
---

# verify — Full project verification

Runs the complete verification pipeline for geniusDebug. Execute this after completing any feature, fix, or refactor to confirm type safety, test passage, and build success.

## When to use

- After finishing a ticket or sprint item
- Before pushing to remote
- After refactoring shared types or schema changes
- When verifying a fix for a reported issue

## Procedure

Run from the project root (`/Users/sharifur/localhost/genius-debug`):

```bash
# Step 1: Typecheck all workspaces
npx tsc --noEmit 2>&1 | head -40
echo "--- typecheck done ---"

# Step 2: Run full test suite
npm test 2>&1 | tail -20
echo "--- tests done ---"

# Step 3: Build web (catches frontend compilation issues)
npm run build -w @geniusdebug/web 2>&1 | tail -5
echo "--- web build done ---"
```

## Shortcut (single command)

```bash
npx tsc --noEmit 2>&1 | head -40 && npm test 2>&1 | tail -20 && npm run build -w @geniusdebug/web 2>&1 | tail -5
```

## Per-workspace checks (when targeting a specific app)

```bash
# Ingest only
npx tsc -p apps/ingest --noEmit 2>&1 | head -10 && npm run test -w @geniusdebug/ingest 2>&1 | tail -10

# Workers only
npx tsc -p apps/workers --noEmit 2>&1 | head -10 && npm run test -w @geniusdebug/workers 2>&1 | tail -10

# API only
npx tsc -p apps/api --noEmit 2>&1 | head -10 && npm run test -w @geniusdebug/api 2>&1 | tail -10

# Web only
npx tsc -p apps/web --noEmit 2>&1 | head -10 && npm run build -w @geniusdebug/web 2>&1 | tail -5
```

## Stopping condition

- All three steps complete without error
- If any step fails, stop and fix before proceeding
- `tsc --noEmit` errors are blocking; test failures are blocking; build failures are blocking

## Notes

- The test suite runs: shared (if present) → ingest → workers → api
- Web has no test runner; verify via build + typecheck
- Workers tests cover: fingerprinting, source-map apply, envelope parse, PHP platform, ingest→pipeline→issue smoke, idempotency
- Ingest tests cover: framing, size caps, gzip, blob fallback
- API tests cover: decode, redact, apply-diff
