import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/** Applies all migrations in ./migrations (including the hand-authored partitioning). */
async function main() {
  if (!process.env.DATABASE_URL) {
    // Fail loudly rather than silently migrating a local fallback DB in prod.
    console.error('[db] DATABASE_URL is not set — refusing to run migrations against the local fallback.');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  console.log('[db] running migrations…');
  await migrate(db, { migrationsFolder: `${__dirname}/../migrations` });
  console.log('[db] migrations complete.');
  await client.end();
}

main().catch((err) => {
  console.error('[db] migration failed:', err);
  process.exit(1);
});
