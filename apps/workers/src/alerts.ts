import { db, alertRules, notifications, events, issues, projects, environments, releases } from '@geniusdebug/db';
import { and, eq, gt, desc, sql as dsql } from 'drizzle-orm';
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

const TRIGGER: Record<string, { label: string; note: string; color: string }> = {
  new: { label: 'New issue', note: 'A new error was seen for the first time.', color: '#4f46e5' },
  regression: { label: 'Regression', note: 'A resolved issue started happening again.', color: '#d97706' },
  frequency: { label: 'Spike', note: 'This issue is happening far more than usual.', color: '#dc2626' },
};

async function sendEmail(recipients: string[], ctx: AlertCtx, kind: string): Promise<void> {
  const trig = TRIGGER[kind] ?? { label: kind, note: '', color: '#4f46e5' };

  // Gather rich, linkable context for the email (FR-ALR-6).
  const row = (
    await db
      .select({
        shortId: issues.shortId,
        culprit: issues.culprit,
        type: issues.type,
        timesSeen: issues.timesSeen,
        usersAffected: issues.usersAffected,
        level: issues.level,
        category: issues.category,
        firstSeen: issues.firstSeen,
        lastSeen: issues.lastSeen,
        projectId: issues.projectId,
        firstReleaseId: issues.firstReleaseId,
      })
      .from(issues)
      .where(eq(issues.id, ctx.issueId))
      .limit(1)
  )[0];
  const link = row ? `${WEB_URL}/issues/${row.shortId}` : WEB_URL;

  const proj = row ? (await db.select({ name: projects.name }).from(projects).where(eq(projects.id, row.projectId)).limit(1))[0] : undefined;
  const ev = (
    await db
      .select({ url: events.url, transaction: events.transaction, environmentId: events.environmentId, contexts: events.contexts })
      .from(events)
      .where(eq(events.issueId, ctx.issueId))
      .orderBy(desc(events.timestamp))
      .limit(1)
  )[0];
  const envName = ev?.environmentId
    ? (await db.select({ name: environments.name }).from(environments).where(eq(environments.id, ev.environmentId)).limit(1))[0]?.name
    : undefined;
  const releaseVer = row?.firstReleaseId
    ? (await db.select({ version: releases.version }).from(releases).where(eq(releases.id, row.firstReleaseId)).limit(1))[0]?.version
    : undefined;

  const ctxObj = (ev?.contexts ?? {}) as Record<string, { name?: string; version?: string }>;
  const nv = (c?: { name?: string; version?: string }) => (c?.name ? [c.name, c.version].filter(Boolean).join(' ') : undefined);
  const fmtDate = (d?: Date | null) => (d ? new Date(d).toUTCString().replace(' GMT', ' UTC') : undefined);

  const rows: [string, string | undefined, boolean?][] = [
    ['Project', proj?.name],
    ['Environment', envName],
    ['Level', row?.level ?? 'error'],
    ['Times seen', String(row?.timesSeen ?? 1)],
    ['Users affected', row?.usersAffected != null ? String(row.usersAffected) : undefined],
    ['Culprit', row?.culprit ?? undefined, true],
    ['Transaction', ev?.transaction ?? undefined, true],
    ['URL', ev?.url ?? undefined, true],
    ['Browser', nv(ctxObj.browser)],
    ['OS', nv(ctxObj.os)],
    ['Release', releaseVer],
    ['First seen', fmtDate(row?.firstSeen)],
    ['Last seen', fmtDate(row?.lastSeen)],
  ];
  const subject = row?.shortId
    ? `[geniusDebug] ${trig.label} · ${row.shortId}: ${ctx.title}`
    : `[geniusDebug] ${trig.label}: ${ctx.title}`;
  const html = renderAlertEmail({ kind, title: ctx.title, type: row?.type ?? null, link, projectName: proj?.name, rows });
  await sendAlertEmail(recipients, subject, html);
}

/** Build the branded alert email HTML (table-based, inline styles, email-safe). */
export function renderAlertEmail(input: {
  kind: string;
  title: string;
  type?: string | null;
  link: string;
  projectName?: string;
  rows: [string, string | undefined, boolean?][];
}): string {
  const trig = TRIGGER[input.kind] ?? { label: input.kind, note: '', color: '#4f46e5' };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const mono = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace';
  const present = input.rows.filter(([, v]) => v);
  const metaRows = present
    .map(
      ([k, v, m], i) =>
        `<tr>
          <td style="padding:8px 16px;font-size:12px;color:#8891a5;white-space:nowrap;vertical-align:top;${i ? 'border-top:1px solid #eceef3' : ''}">${esc(k)}</td>
          <td style="padding:8px 16px;font-size:13px;color:#1b1f2a;${m ? mono : ''};word-break:break-all;${i ? 'border-top:1px solid #eceef3' : ''}">${esc(v as string)}</td>
        </tr>`,
    )
    .join('');
  return `
  <div style="background:#f4f5f8;padding:24px 12px;margin:0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e6e8ef;border-radius:14px;overflow:hidden;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
      <tr><td style="height:4px;background:${trig.color};font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="padding:18px 24px 0">
        <table role="presentation" width="100%"><tr>
          <td style="font-size:15px;font-weight:700;color:#1b1f2a">genius<span style="color:#6c5fc7">Debug</span></td>
          <td align="right"><span style="display:inline-block;background:${trig.color};color:#fff;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:4px 10px;border-radius:999px">${esc(trig.label)}</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:14px 24px 4px">
        <div style="font-size:20px;line-height:1.3;font-weight:700;color:#1b1f2a">${esc(input.title)}</div>
        ${input.type ? `<div style="margin-top:4px;font-size:13px;color:#8891a5;${mono}">${esc(input.type)}</div>` : ''}
        ${trig.note ? `<div style="margin-top:8px;font-size:13px;color:#6b7280">${esc(trig.note)}</div>` : ''}
      </td></tr>
      <tr><td style="padding:14px 24px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef3;border-radius:10px;border-collapse:separate;overflow:hidden">
          ${metaRows}
        </table>
      </td></tr>
      <tr><td style="padding:20px 24px 6px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#6c5fc7;border-radius:9px">
          <a href="${input.link}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Open issue in geniusDebug →</a>
        </td></tr></table>
        <div style="margin-top:10px;font-size:12px;color:#9aa1b1;word-break:break-all">${esc(input.link)}</div>
      </td></tr>
      <tr><td style="padding:16px 24px 22px;border-top:1px solid #eceef3">
        <div style="font-size:11px;color:#9aa1b1;line-height:1.5">
          You're receiving this because you're on an alert rule${input.projectName ? ` for <b style="color:#6b7280">${esc(input.projectName)}</b>` : ''}.
          Manage alerts and recipients in geniusDebug → Alerts.
        </div>
      </td></tr>
    </table>
  </div>`;
}
