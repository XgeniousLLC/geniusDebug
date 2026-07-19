import type { IssueDto, EventDto, NormalizedFrame } from '@geniusdebug/shared';

/**
 * Serialize an issue + its latest event into a structured Markdown document
 * optimized for an AI coding agent to identify and fix the error (GD-142):
 * error signature, symbolicated stack trace with source context, breadcrumbs
 * (repro trail), runtime context, tags, and an explicit task prompt.
 */
export function buildAgentMarkdown(issue: IssueDto, event: EventDto | null): string {
  const L: string[] = [];
  const ctx = (event?.contexts ?? {}) as Record<string, { name?: string; version?: string; model?: string }>;

  L.push(`# 🐛 ${issue.title}`, '');
  L.push('## Summary');
  L.push(`- **Issue**: ${issue.shortId} · level \`${issue.level}\` · category \`${issue.category}\` · status \`${issue.status}\`${issue.isRegressed ? ' · **regressed**' : ''}`);
  if (issue.culprit) L.push(`- **Culprit**: \`${issue.culprit}\``);
  L.push(`- **Occurrences**: ${issue.timesSeen} (users affected: ${issue.usersAffected})`);
  L.push(`- **First seen**: ${issue.firstSeen} · **Last seen**: ${issue.lastSeen}`);
  if (event) {
    L.push(`- **Handled**: ${event.handled} · **Environment**: ${event.environment}${event.release ? ` · **Release**: ${event.release}` : ''}`);
    if (event.transaction) L.push(`- **Transaction**: \`${event.transaction}\``);
    if (event.url) L.push(`- **URL**: ${event.url}`);
    if (event.traceId) L.push(`- **Trace ID**: \`${event.traceId}\``);
  }
  L.push('');

  const exc = event?.exception;
  if (exc?.type || exc?.value) {
    L.push('## Error', '```', `${exc.type ?? 'Error'}: ${exc.value ?? issue.title}`, '```', '');
  }

  const frames: NormalizedFrame[] = exc?.frames ?? [];
  if (frames.length) {
    L.push('## Stack trace', '');
    // In-app frames first, most-relevant last-to-first (crash frame last in array → show innermost first).
    const ordered = [...frames].reverse();
    for (const f of ordered) {
      const loc = `${f.filename ?? f.module ?? '<unknown>'}${f.lineno ? `:${f.lineno}` : ''}`;
      L.push(`### ${loc} — \`${f.function ?? '<anonymous>'}\`${f.inApp ? ' _(in-app)_' : ''}`);
      if (f.githubUrl) L.push(`GitHub: ${f.githubUrl}`);
      if (f.contextLine || f.preContext?.length || f.postContext?.length) {
        L.push('```');
        const start = (f.lineno ?? (f.preContext?.length ?? 0) + 1) - (f.preContext?.length ?? 0);
        let n = start;
        for (const line of f.preContext ?? []) L.push(`  ${n++} | ${line}`);
        if (f.contextLine != null) L.push(`> ${n++} | ${f.contextLine}`);
        for (const line of f.postContext ?? []) L.push(`  ${n++} | ${line}`);
        L.push('```');
      }
      L.push('');
    }
  }

  const crumbs = event?.breadcrumbs ?? [];
  if (crumbs.length) {
    L.push('## Breadcrumbs (user actions leading to the error)', '');
    for (const b of crumbs.slice(-25)) {
      const cat = String((b.category as string) ?? (b.type as string) ?? 'log');
      const msg = String((b.message as string) ?? (b.data ? JSON.stringify(b.data) : ''));
      L.push(`- \`${cat}\` ${msg}`.trim());
    }
    L.push('');
  }

  const ctxLines: string[] = [];
  for (const key of ['browser', 'os', 'device', 'runtime']) {
    const c = ctx[key];
    if (c?.name) ctxLines.push(`- **${key}**: ${c.name}${c.version ? ` ${c.version}` : ''}${c.model ? ` (${c.model})` : ''}`);
  }
  if (ctxLines.length) L.push('## Runtime context', ...ctxLines, '');

  const tags = event?.tags ?? {};
  const tagKeys = Object.keys(tags);
  if (tagKeys.length) {
    L.push('## Tags', ...tagKeys.map((k) => `- ${k}: ${tags[k]}`), '');
  }

  const crashFrame = frames.find((f) => f.inApp) ?? frames[frames.length - 1];
  const crashLoc = crashFrame ? `${crashFrame.filename ?? '<unknown>'}${crashFrame.lineno ? `:${crashFrame.lineno}` : ''}` : 'the top in-app frame';
  L.push('## Task for the AI agent');
  L.push(
    `You are an expert debugger. Identify the **root cause** of the error above and propose a **minimal fix** as a unified diff.`,
    `The crash originates at \`${crashLoc}\`${crashFrame?.contextLine ? `: \`${crashFrame.contextLine.trim()}\`` : ''}.`,
    `Use the breadcrumbs as reproduction steps and the source context to reason about state. Explain the fix briefly, then output the patch.`,
  );
  L.push('', '---', `_Exported from geniusDebug · ${issue.shortId}_`);

  return L.join('\n');
}
