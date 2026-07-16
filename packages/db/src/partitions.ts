import { sql } from './client';

/**
 * Events partition maintenance (NFR-SCALE-3 / FR-RET-1). `events` is
 * PARTITION BY RANGE (timestamp); this rolls monthly partitions forward so new
 * events never fall into the catch-all `events_default`, and drops partitions
 * older than retention (cheap bulk delete). Run daily from the worker.
 *
 * `now` is injected (workflow/runtime forbids Date.now() in some contexts;
 * callers pass a real Date).
 */
function monthBounds(d: Date): { name: string; from: string; to: string } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-based
  const from = new Date(Date.UTC(y, m, 1));
  const to = new Date(Date.UTC(y, m + 1, 1));
  const name = `events_${y}_${String(m + 1).padStart(2, '0')}`;
  return { name, from: from.toISOString(), to: to.toISOString() };
}

/** Ensure this month + `monthsAhead` partitions exist. */
export async function ensurePartitions(now: Date, monthsAhead = 3): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const { name, from, to } = monthBounds(d);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "events" FOR VALUES FROM ('${from}') TO ('${to}')`,
    );
    created.push(name);
  }
  return created;
}

/** Drop partitions strictly older than the retention window. */
export async function dropAgedPartitions(now: Date, retentionDays: number): Promise<string[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const dropped: string[] = [];
  // Only touch our monthly partitions (never events_default).
  const rows = await sql<{ child: string }[]>`
    SELECT c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'events' AND c.relname ~ '^events_[0-9]{4}_[0-9]{2}$'`;
  for (const { child } of rows) {
    const m = /^events_(\d{4})_(\d{2})$/.exec(child);
    if (!m) continue;
    // Partition upper bound = first day of the following month.
    const upper = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
    if (upper <= cutoff) {
      await sql.unsafe(`DROP TABLE IF EXISTS "${child}"`);
      dropped.push(child);
    }
  }
  return dropped;
}
