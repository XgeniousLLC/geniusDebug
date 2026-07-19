import { db, alertRules, notifications, events, issues } from '@geniusdebug/db';
import { and, eq, gt, sql as dsql } from 'drizzle-orm';
import { sendAlertEmail } from './ses';

const WEB_URL = process.env.WEB_URL ?? 'http://localhost:5199';

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

    await sendEmail(rule.recipients ?? [], ctx, kind);
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

async function sendEmail(recipients: string[], ctx: AlertCtx, kind: string): Promise<void> {
  const subjectMap: Record<string, string> = {
    new: `[geniusDebug] New issue: ${ctx.title}`,
    regression: `[geniusDebug] Regression: ${ctx.title}`,
    frequency: `[geniusDebug] Spike: ${ctx.title}`,
  };
  const labelMap: Record<string, string> = {
    new: 'New issue',
    regression: 'Regression re-opened',
    frequency: 'Spike — seen many times in a short window',
  };

  // Resolve the short id / culprit / count for a useful, linkable email (FR-ALR-6).
  const row = (
    await db
      .select({ shortId: issues.shortId, culprit: issues.culprit, timesSeen: issues.timesSeen, level: issues.level })
      .from(issues)
      .where(eq(issues.id, ctx.issueId))
      .limit(1)
  )[0];
  const link = row ? `${WEB_URL}/issues/${row.shortId}` : WEB_URL;

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `
    <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
      <p style="margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#6b6b6b">${esc(labelMap[kind] ?? kind)}</p>
      <h2 style="margin:0 0 12px;font-size:18px;line-height:1.35">${esc(ctx.title)}</h2>
      ${row?.shortId ? `<p style="margin:0 0 4px;font-size:13px;color:#6b6b6b"><b style="color:#1a1a1a">Issue</b> ${esc(row.shortId)} · level ${esc(row.level ?? 'error')} · seen ${row.timesSeen ?? 1}×</p>` : ''}
      ${row?.culprit ? `<p style="margin:0 0 16px;font-size:13px;color:#6b6b6b"><b style="color:#1a1a1a">Culprit</b> <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(row.culprit)}</code></p>` : ''}
      <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px;font-weight:600">Open issue in geniusDebug →</a>
      <p style="margin:16px 0 0;font-size:12px;color:#9a9a9a">${esc(link)}</p>
    </div>`;
  await sendAlertEmail(recipients, subjectMap[kind] ?? ctx.title, html);
}
