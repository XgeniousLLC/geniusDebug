import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { db, sql } from './client';
import { organizations, users, memberships } from '../schema';
import { eq } from 'drizzle-orm';

/**
 * Local-dev-only fixture: a known-password admin account so `npm run dev` +
 * the web login page always has working test credentials, without touching
 * any real registered account. Idempotent — safe to re-run (resets the
 * password if the account already exists). Never wired into prod (no script
 * calls this automatically; deploy pipelines don't run `seed:dev-user`).
 */
const DEV_EMAIL = 'admin@geniusdebug.test';
const DEV_PASSWORD = 'DevPass123!';
const DEV_NAME = 'Dev Test Admin';

async function main() {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);

  const existing = await db.select({ id: users.id, orgId: users.orgId }).from(users).where(eq(users.email, DEV_EMAIL)).limit(1);

  if (existing.length > 0) {
    await db.update(users).set({ passwordHash }).where(eq(users.id, existing[0].id));
    console.log(`[seed-dev-user] Reset password for existing ${DEV_EMAIL}`);
  } else {
    // Join whichever org already has data (first registered org) so the test
    // account sees the same projects/issues as the real admin, if one exists.
    const org = await db.select({ id: organizations.id }).from(organizations).limit(1);
    let orgId = org[0]?.id;
    if (!orgId) {
      const created = await db.insert(organizations).values({ name: 'Dev Org' }).returning({ id: organizations.id });
      orgId = created[0].id;
    }
    const inserted = await db
      .insert(users)
      .values({ orgId, email: DEV_EMAIL, passwordHash, name: DEV_NAME })
      .returning({ id: users.id });
    await db.insert(memberships).values({ orgId, userId: inserted[0].id, role: 'admin' });
    console.log(`[seed-dev-user] Created ${DEV_EMAIL} (admin) in org ${orgId}`);
  }

  console.log(`[seed-dev-user] Login with: ${DEV_EMAIL} / ${DEV_PASSWORD}`);
  await sql.end();
}

main().catch((e) => {
  console.error('[seed-dev-user] failed:', e);
  process.exit(1);
});
