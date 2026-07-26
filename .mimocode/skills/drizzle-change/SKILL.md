---
name: drizzle-change
description: Schema change workflow — edit schema.ts, generate migration, review SQL, apply, rebuild. Follow this for every database change.
---

# drizzle-change — Schema change workflow

The database schema lives in `packages/db/schema.ts`. This skill covers the full cycle: edit → generate → review → migrate → rebuild.

## When to use

- Adding a new table
- Adding columns to existing tables
- Changing indexes
- Modifying constraints

## Procedure

### 1. Edit schema

Edit `packages/db/schema.ts`. Follow existing conventions:
- Use `pgTable` with explicit column types
- Add indexes with `index()` or `uniqueIndex()` on columns used in WHERE/JOIN
- Reference SRS requirement IDs in comments where useful (e.g. `// FR-RET-1`)
- Events table is range-partitioned — the base table definition is in schema.ts; partitions are hand-authored in migrations

### 2. Generate migration

```bash
npm run db:generate 2>&1 | tail -10
```

This creates a new SQL file in `packages/db/migrations/`.

### 3. Review the generated SQL

```bash
ls -t packages/db/migrations/*.sql | head -1
cat packages/db/migrations/<new_file>.sql
```

Check for:
- Correct column types and defaults
- Index names don't conflict
- No unintended drops or renames
- Partition-related DDL is NOT generated (partitions are hand-authored)

### 4. Apply migration

```bash
npm run db:migrate 2>&1 | tail -5
```

### 5. Rebuild db package

```bash
npm run build -w @geniusdebug/db 2>&1 | tail -3
```

### 6. Verify

```bash
# Confirm table structure
psql -d geniusdebug_dev -c "\dt" | grep <table_name>

# Run full verification
npx tsc --noEmit 2>&1 | head -20 && npm test 2>&1 | tail -10
```

## Hand-authored partition migrations

When adding new time partitions (e.g. for next month):

```sql
-- In a migration file, hand-add:
CREATE TABLE IF NOT EXISTS events_2026_08 PARTITION OF events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

Drizzle does NOT manage partitions. Always hand-author them in migrations.

## Quick reference

| Command | What it does |
|---------|-------------|
| `npm run db:generate` | Reads schema.ts, outputs new migration SQL |
| `npm run db:migrate` | Applies pending migrations to the database |
| `npm run db:seed` | Seeds reference data (for development) |
| `npm run build -w @geniusdebug/db` | Rebuilds the db package after schema changes |

## Stopping condition

- Migration applied successfully
- `tsc --noEmit` passes
- Tests pass
- New table/columns visible in psql
