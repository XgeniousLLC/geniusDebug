import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from '@geniusdebug/db';
import {
  organizations,
  users,
  memberships,
  projects,
  dsnKeys,
  environments,
  alertRules,
} from '@geniusdebug/db';
import { eq, sql as dsql } from 'drizzle-orm';
import type { RegisterInput, LoginInput, AuthUserDto } from '@geniusdebug/shared';

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  /** True when no user exists yet — drives the "first-time login (register)" UX. */
  async isFirstRun(): Promise<boolean> {
    const rows = await db.select({ c: dsql<number>`count(*)::int` }).from(users);
    return (rows[0]?.c ?? 0) === 0;
  }

  /**
   * Register the first (or a new) user. The FIRST user also creates the org and a
   * default project + DSN + environments + alert rule so ingest works immediately
   * (FR-ADM-1..3, FR-SDK-2). Single-org v1 (SRS §2.6).
   */
  async register(input: RegisterInput): Promise<{ token: string; user: AuthUserDto }> {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
    if (existing.length > 0) throw new ConflictException('email already registered');

    const firstRun = await this.isFirstRun();

    // Single-org v1: reuse the org if one exists, else create it.
    let orgId: string;
    const orgRows = await db.select({ id: organizations.id }).from(organizations).limit(1);
    if (orgRows.length > 0) {
      orgId = orgRows[0].id;
    } else {
      const org = await db
        .insert(organizations)
        .values({ name: input.orgName ?? `${input.name}'s Org` })
        .returning({ id: organizations.id });
      orgId = org[0].id;
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    const role: 'admin' | 'member' = firstRun ? 'admin' : 'member';
    const user = await db
      .insert(users)
      .values({ orgId, email: input.email, passwordHash, name: input.name })
      .returning({ id: users.id, email: users.email, name: users.name });
    await db.insert(memberships).values({ orgId, userId: user[0].id, role });

    if (firstRun) await this.provisionDefaultProject(orgId, input.email);

    const token = this.sign({ userId: user[0].id, orgId, role, email: user[0].email });
    return { token, user: { id: user[0].id, email: user[0].email, name: user[0].name, orgId, role } };
  }

  async login(input: LoginInput): Promise<{ token: string; user: AuthUserDto }> {
    const rows = await db
      .select({ id: users.id, email: users.email, name: users.name, orgId: users.orgId, hash: users.passwordHash })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (rows.length === 0) throw new UnauthorizedException('invalid credentials');
    const ok = await bcrypt.compare(input.password, rows[0].hash);
    if (!ok) throw new UnauthorizedException('invalid credentials');

    const mem = await db
      .select({ role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, rows[0].id))
      .limit(1);
    const role = (mem[0]?.role ?? 'member') as 'admin' | 'member';

    const token = this.sign({ userId: rows[0].id, orgId: rows[0].orgId, role, email: rows[0].email });
    return { token, user: { id: rows[0].id, email: rows[0].email, name: rows[0].name, orgId: rows[0].orgId, role } };
  }

  private async provisionDefaultProject(orgId: string, ownerEmail: string): Promise<void> {
    const proj = await db
      .insert(projects)
      .values({ orgId, name: 'Taskip', slug: 'taskip', platform: 'javascript-nextjs' })
      .returning({ id: projects.id });
    const projectId = proj[0].id;

    const publicKey = randomBytes(16).toString('hex');
    await db.insert(dsnKeys).values({ projectId, publicKey, rateLimit: 3000 });

    for (const name of ['vercel-production', 'preview', 'development']) {
      await db.insert(environments).values({ projectId, name });
    }

    await db.insert(alertRules).values({
      projectId,
      name: 'Default — new & regressed issues',
      conditions: { new: true, regression: true },
      recipients: [ownerEmail],
      channel: 'email',
      throttleWindow: 3600,
    });
  }

  /** Start password reset (brief §5). Returns the link in dev (SES sends it later). */
  async forgot(email: string): Promise<{ ok: true; devLink?: string }> {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (rows.length === 0) return { ok: true }; // don't leak which emails exist
    const token = randomBytes(24).toString('hex');
    const tokenHash = await bcrypt.hash(token, 10);
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1h
    await db.update(users).set({ resetTokenHash: tokenHash, resetExpires: expires }).where(eq(users.id, rows[0].id));
    const link = `${process.env.WEB_URL ?? 'http://localhost:5199'}/reset?token=${token}&email=${encodeURIComponent(email)}`;
    // eslint-disable-next-line no-console
    console.log(`[auth] password reset link for ${email}: ${link}`);
    return { ok: true, devLink: process.env.NODE_ENV === 'production' ? undefined : link };
  }

  async reset(email: string, token: string, newPassword: string): Promise<{ ok: true }> {
    if (newPassword.length < 8) throw new ConflictException('password too short');
    const rows = await db
      .select({ id: users.id, hash: users.resetTokenHash, expires: users.resetExpires })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const u = rows[0];
    if (!u?.hash || !u.expires || u.expires.getTime() < Date.now()) throw new UnauthorizedException('invalid or expired token');
    if (!(await bcrypt.compare(token, u.hash))) throw new UnauthorizedException('invalid token');
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await db.update(users).set({ passwordHash, resetTokenHash: null, resetExpires: null }).where(eq(users.id, u.id));
    return { ok: true };
  }

  private sign(p: { userId: string; orgId: string; role: 'admin' | 'member'; email: string }): string {
    return this.jwt.sign(p);
  }
}
