---
name: drizzle-change
description: Use when changing the PostgreSQL schema — adding or altering tables/columns/indexes/enums in the Drizzle schema, generating or applying migrations, or anything touching the geniusDebug data model. Trigger on schema edits, "add a column/table", "new migration", or drizzle-kit commands.
---

# Drizzle schema change workflow

Schema lives in `packages/db/schema.ts` (single source of truth). Data model reference: SRS Section 7.

## Steps
1. **Edit `schema.ts`** — add/alter the table, column, enum, or index. Follow existing conventions: `snake_case` DB columns, `uuid('id').defaultRandom().primaryKey()`, `timestamp(..., { withTimezone: true })`, `jsonb` for structured blobs, `references(() => other.id, { onDelete: ... })`.
2. **Add the indexes the queries need** (SRS Section 7): issue list `(project_id, status, last_seen)`, symbolication `(project_id, debug_id)` unique, events `(issue_id, timestamp)`, uniqueness like `(project_id, fingerprint)`.
3. **Generate** the migration: `npx drizzle-kit generate` -> creates SQL in `packages/db/migrations/`.
4. **Review the generated SQL** before applying — Drizzle can produce destructive steps (drops, type changes). Never apply blindly to a DB with data.
5. **Apply**: `npx drizzle-kit migrate` (or run migrations in the deploy step).

## Critical caveats
- **`events` is time-partitioned.** Drizzle emits a plain table; the `PARTITION BY RANGE (timestamp)` declaration and the partition tables are **hand-authored SQL** in a migration. If you regenerate, re-apply the partitioning migration on top — don't let a regenerate silently drop it.
- **Blobs go to R2, not Postgres.** Store only metadata + `r2Key` pointers (replay segments, source maps).
- **Retention.** New large tables need a purge story (SRS Section 5.11) — events/replays/source maps age out; don't add unbounded growth without a cleanup path.
- **Store tokens hashed.** GitHub installation tokens and org upload tokens are encrypted/hashed at rest (NFR-SEC-5), never plaintext.

## After changing
- Update `docs/geniusDebug-SRS.md` Section 7 if the logical model changed.
- Regenerate shared TS types if other packages consume the row types.
