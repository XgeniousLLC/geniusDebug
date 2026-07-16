import { db, alertRules, notifications } from '@geniusdebug/db';
import { and, eq, gt, sql as dsql } from 'drizzle-orm';

interface AlertCtx {
  projectId: string;
  issueId: string;
  title: string;
  isNew: boolean;
  regressed: boolean;
}

/**
 * Evaluate alert rules and send deduped/throttled email (FR-ALR-1/2/4/6).
 * Anti-spam is first-class: within a rule's throttle window we send at most one
 * email per dedupe key. SES send is stubbed in dev (logged); the throttle +
 * notification ledger is real.
 */
export async function evaluateAlerts(ctx: AlertCtx): Promise<void> {
  if (!ctx.isNew && !ctx.regressed) return; // only new / regressed trigger in v1

  const rules = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.projectId, ctx.projectId), eq(alertRules.isActive, true)));

  for (const rule of rules) {
    const conditions = (rule.conditions ?? {}) as Record<string, unknown>;
    const wantsNew = conditions.new === true;
    const wantsRegression = conditions.regression === true;
    if (ctx.isNew && !wantsNew) continue;
    if (ctx.regressed && !wantsRegression) continue;

    const kind = ctx.isNew ? 'new' : 'regression';
    const dedupeKey = `${rule.id}:${ctx.issueId}:${kind}`;
    const windowStart = new Date(Date.now() - rule.throttleWindow * 1000);

    const recent = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.dedupeKey, dedupeKey), gt(notifications.sentAt, windowStart)))
      .limit(1);
    if (recent.length > 0) continue; // throttled — never spam (FR-ALR-4)

    await sendEmail(rule.recipients ?? [], ctx.title, kind);
    await db.insert(notifications).values({
      projectId: ctx.projectId,
      issueId: ctx.issueId,
      ruleId: rule.id,
      channel: 'email',
      status: 'sent',
      dedupeKey,
    });
  }
}

async function sendEmail(recipients: string[], title: string, kind: string): Promise<void> {
  // TODO: wire AWS SES SendEmail here (server-side creds only). Dev = log.
  // eslint-disable-next-line no-console
  console.log(`[alert] ${kind} → ${recipients.join(', ') || '(no recipients)'}: ${title}`);
}
