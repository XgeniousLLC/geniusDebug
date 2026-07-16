import { db, alertRules, notifications, events } from '@geniusdebug/db';
import { and, eq, gt, sql as dsql } from 'drizzle-orm';
import { sendAlertEmail } from './ses';

interface AlertCtx {
  projectId: string;
  issueId: string;
  title: string;
  isNew: boolean;
  regressed: boolean;
}

/**
 * Evaluate alert rules: new issue (FR-ALR-1), regression (FR-ALR-2), and
 * frequency/spike — "seen > N times in M minutes" (FR-ALR-3). Deduped + throttled
 * (FR-ALR-4) and respects a per-rule snooze window (FR-ALR-7). SES send activates
 * when configured; dev logs.
 */
export async function evaluateAlerts(ctx: AlertCtx): Promise<void> {
  const rules = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.projectId, ctx.projectId), eq(alertRules.isActive, true)));

  const now = Date.now();
  for (const rule of rules) {
    if (rule.mutedUntil && rule.mutedUntil.getTime() > now) continue; // snoozed (FR-ALR-7)

    const cond = (rule.conditions ?? {}) as {
      new?: boolean;
      regression?: boolean;
      frequency?: { count: number; windowMin: number };
    };

    let kind: string | null = null;
    if (ctx.isNew && cond.new) kind = 'new';
    else if (ctx.regressed && cond.regression) kind = 'regression';
    else if (cond.frequency && (await frequencyExceeded(ctx.issueId, cond.frequency))) kind = 'frequency';
    if (!kind) continue;

    const dedupeKey = `${rule.id}:${ctx.issueId}:${kind}`;
    const windowStart = new Date(now - rule.throttleWindow * 1000);
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

async function frequencyExceeded(issueId: string, freq: { count: number; windowMin: number }): Promise<boolean> {
  const since = new Date(Date.now() - freq.windowMin * 60 * 1000);
  const rows = await db
    .select({ c: dsql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.issueId, issueId), gt(events.timestamp, since)));
  return (rows[0]?.c ?? 0) >= freq.count;
}

async function sendEmail(recipients: string[], title: string, kind: string): Promise<void> {
  const subjectMap: Record<string, string> = {
    new: `[geniusDebug] New issue: ${title}`,
    regression: `[geniusDebug] Regression: ${title}`,
    frequency: `[geniusDebug] Spike: ${title}`,
  };
  const html = `<h2>${title}</h2><p>Trigger: ${kind}</p>`;
  await sendAlertEmail(recipients, subjectMap[kind] ?? title, html);
}
