import type { IssueDto, EventDto, NormalizedFrame } from '@geniusdebug/shared';
import { normalizeFramePath, pickSuspectFrame } from '@geniusdebug/shared';

/**
 * Serialize an issue + one occurrence (event) into a structured Markdown
 * document optimized for an AI coding agent to identify and fix the error
 * (GD-142, rebuilt): error signature, prime suspect, HTTP request, affected
 * user, symbolicated stack trace (vendor frames collapsed), breadcrumbs
 * (deduped repro trail), platform-aware environment, all contexts, tags,
 * and an explicit task prompt.
 *
 * Platform-aware: Laravel/PHP and Next.js/JS occurrences each get the
 * context that matters for them (artisan command + PHP runtime vs browser
 * + device + React component stack), inferred from the event SDK payload.
 * Unknown platforms fall back to the generic full dump — nothing is
 * dropped just because the platform wasn't recognized.
 */

export type AgentPlatform = 'php' | 'javascript' | 'unknown';

export interface SuspectCommit {
  sha: string;
  message: string;
  author: string;
  url: string;
}

export interface AgentExportLinks {
  issueUrl?: string;
  traceUrl?: string;
  replayUrl?: string | null;
  suspectCommits?: SuspectCommit[];
}

export interface AgentExportOptions {
  /** Collapse consecutive non-in-app frames to one line (default true). */
  collapseVendorFrames?: boolean;
  /** Include the (scrubbed) request body (default true). */
  includeRequestBody?: boolean;
  /** e.g. "Event 3 of 28" — the selected occurrence in the UI. */
  occurrenceLabel?: string;
  links?: AgentExportLinks;
}

const FIELD_TRUNCATE = 2000;
const BODY_TRUNCATE = 8000;
const MAX_DOC = 120_000;

const SECRET_KEY_RE = /passw(or)?d|passwd|secret|token|api[-_ ]?key|auth|private[-_ ]?key|cookie|session|csrf/i;
const SENSITIVE_HEADER_RE = /cookie|authorization|set-cookie|x-csrf|xsrf/i;

/** Platform of this occurrence, inferred from the SDK + context clues. */
export function inferPlatform(event: EventDto | null): AgentPlatform {
  const sdkName = String((event?.sdk as Record<string, unknown> | null)?.name ?? '').toLowerCase();
  if (/laravel|^sentry\.php|sentry-php|symfony/.test(sdkName)) return 'php';
  if (/javascript|next|react|node|browser/.test(sdkName)) return 'javascript';
  const ctx = (event?.contexts ?? {}) as Record<string, unknown>;
  if (ctx['browser'] && typeof ctx['browser'] === 'object') return 'javascript';
  if (event?.tags?.command) return 'php';
  return 'unknown';
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Redact secret-looking values inside an arbitrary JSON-able value. */
export function redactValue(key: string | null, value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated: too deep]';
  if (typeof value === 'string') {
    if (key && SECRET_KEY_RE.test(key)) return '[redacted]';
    return truncate(value, FIELD_TRUNCATE);
  }
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => redactValue(null, v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redactValue(k, v, depth + 1);
  }
  return out;
}

/** Headers minus cookie/auth values (mirrors HttpRequestCard's scrub). */
export function scrubHeaders(headers: unknown): [string, string][] {
  if (!headers || typeof headers !== 'object') return [];
  return Object.entries(headers as Record<string, unknown>)
    .filter(([k]) => !SENSITIVE_HEADER_RE.test(k))
    .map(([k, v]) => [k, truncate(typeof v === 'string' ? v : JSON.stringify(v), FIELD_TRUNCATE)]);
}

function frameLoc(f: NormalizedFrame): string {
  const p = normalizeFramePath(f.filename ?? f.module) ?? '<unknown>';
  return `${p}${f.lineno ? `:${f.lineno}` : ''}${f.colno ? `:${f.colno}` : ''}`;
}

function frameContextBlock(f: NormalizedFrame): string[] {
  if (!f.contextLine && !f.preContext?.length && !f.postContext?.length) return [];
  const L = ['```'];
  const start = (f.lineno ?? (f.preContext?.length ?? 0) + 1) - (f.preContext?.length ?? 0);
  let n = start;
  for (const line of f.preContext ?? []) L.push(`  ${n++} | ${line}`);
  if (f.contextLine != null) L.push(`> ${n++} | ${f.contextLine}`);
  for (const line of f.postContext ?? []) L.push(`  ${n++} | ${line}`);
  L.push('```');
  return L;
}

/** Collapse consecutive non-in-app frames into one marker line. */
export function renderTrace(frames: NormalizedFrame[], collapse: boolean): string[] {
  const L: string[] = [];
  if (!frames.length) return L;
  L.push('## Stack trace', '');
  // Innermost (crash) frame first.
  const ordered = [...frames].reverse();
  if (!collapse) {
    for (const f of ordered) {
      L.push(`### ${frameLoc(f)} — \`${f.function ?? '<anonymous>'}\`${f.inApp ? ' _(in-app)_' : ''}`);
      if (f.githubUrl) L.push(`GitHub: ${f.githubUrl}`);
      L.push(...frameContextBlock(f), '');
    }
    return L;
  }
  let i = 0;
  while (i < ordered.length) {
    const f = ordered[i];
    if (f.inApp) {
      L.push(`### ${frameLoc(f)} — \`${f.function ?? '<anonymous>'}\` _(in-app)_`);
      if (f.githubUrl) L.push(`GitHub: ${f.githubUrl}`);
      L.push(...frameContextBlock(f), '');
      i++;
      continue;
    }
    // Consume the whole vendor run.
    let j = i;
    while (j < ordered.length && !ordered[j].inApp) j++;
    const run = ordered.slice(i, j);
    const first = frameLoc(run[0]);
    const last = run.length > 1 ? ` → ${frameLoc(run[run.length - 1])}` : '';
    L.push(`_… ${run.length} framework frame${run.length > 1 ? 's' : ''} collapsed: ${first}${last} …_`, '');
    i = j;
  }
  return L;
}

interface Crumb {
  row: string;
  key: string;
}

/** Collapse consecutive identical breadcrumbs (category+message) with ×N. */
export function renderBreadcrumbs(crumbs: Array<Record<string, unknown>>): string[] {
  const L: string[] = [];
  if (!crumbs.length) return L;
  L.push('## Breadcrumbs (repro trail — what happened before the error)', '');
  const rows: Crumb[] = crumbs.slice(-25).map((b) => {
    const cat = String((b['category'] as string) ?? (b['type'] as string) ?? 'log');
    const level = b['level'] ? ` [${String(b['level'])}]` : '';
    let ts = '';
    if (b['timestamp'] != null) {
      const d = new Date(typeof b['timestamp'] === 'number' ? (b['timestamp'] as number) * 1000 : String(b['timestamp']));
      if (!Number.isNaN(d.getTime())) ts = ` @${d.toISOString()}`;
    }
    const msg = String((b['message'] as string) ?? (b['data'] ? truncate(JSON.stringify(redactValue(null, b['data'])), 500) : ''));
    const row = `- \`${cat}\`${level} ${msg}${ts}`.trim();
    return { row, key: `${cat}|${msg}` };
  });
  let k = 0;
  while (k < rows.length) {
    let m = k;
    while (m < rows.length && rows[m].key === rows[k].key) m++;
    const n = m - k;
    L.push(n > 1 ? `${rows[k].row} _(×${n} repeated)_` : rows[k].row);
    k = m;
  }
  L.push('');
  return L;
}

/** Sentry-style derived tags merged with stored tags (mirrors the Tags tab). */
export function derivedTags(issue: IssueDto, event: EventDto | null): Record<string, string> {
  const c = (event?.contexts ?? {}) as Record<string, { name?: string; version?: string; family?: string; model?: string }>;
  const derived: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') derived[k] = String(v);
  };
  put('level', event?.level ?? issue.level);
  put('handled', event ? (event.handled ? 'yes' : 'no') : undefined);
  put('environment', event?.environment);
  put('release', event?.release);
  put('transaction', event?.transaction);
  put('url', event?.url);
  if (c['browser']?.name) put('browser', `${c['browser'].name}${c['browser'].version ? ` ${c['browser'].version}` : ''}`);
  put('browser.name', c['browser']?.name);
  if (c['os']?.name) put('os', `${c['os'].name}${c['os'].version ? ` ${c['os'].version}` : ''}`);
  put('os.name', c['os']?.name);
  if (c['device']?.family || c['device']?.model) put('device', c['device']?.family ?? c['device']?.model);
  return { ...derived, ...(event?.tags ?? {}) };
}

function renderRequest(request: Record<string, unknown> | null, includeBody: boolean): string[] {
  const L: string[] = [];
  if (!request || Object.keys(request).length === 0) return L;
  L.push('## HTTP Request', '');
  const method = (request['method'] as string) ?? 'GET';
  const url = (request['url'] as string) ?? '';
  L.push(`\`${method} ${url || '(no url captured)'}\``, '');
  if (request['query_string']) L.push(`- **Query string**: \`${truncate(String(request['query_string']), FIELD_TRUNCATE)}\``);
  const headers = request['headers'];
  const shown = scrubHeaders(headers);
  const ua = shown.find(([k]) => k.toLowerCase() === 'user-agent');
  if (ua) L.push(`- **User-Agent**: \`${ua[1]}\``);
  const rest = ua ? shown.filter(([k]) => k.toLowerCase() !== 'user-agent') : shown;
  if (rest.length) {
    L.push('', '### Headers');
    for (const [k, v] of rest) L.push(`- \`${k}\`: ${v}`);
  }
  const rawHeaders = headers && typeof headers === 'object' ? Object.keys(headers as Record<string, unknown>).length : 0;
  if (rawHeaders > shown.length) L.push(`- _(${rawHeaders - shown.length} sensitive header(s) omitted: cookie/authorization)_`);
  if (request['cookies'] && typeof request['cookies'] === 'object') {
    const names = Object.keys(request['cookies'] as Record<string, unknown>);
    if (names.length) L.push(`- **Cookies present** (${names.length}, values omitted): ${names.join(', ')}`);
  }
  if ('data' in request && request['data'] !== undefined && request['data'] !== null) {
    L.push('', '### Body / payload');
    if (!includeBody) {
      L.push('_Body omitted by export option._');
    } else {
      const redacted = redactValue(null, request['data']);
      L.push('```json', truncate(JSON.stringify(redacted, null, 2), BODY_TRUNCATE), '```');
    }
  }
  L.push('');
  return L;
}

function renderUser(user: Record<string, unknown> | null): string[] {
  if (!user || Object.keys(user).length === 0) return [];
  const L = ['## Affected user (this occurrence)', ''];
  for (const [k, v] of Object.entries(user)) {
    const val = SECRET_KEY_RE.test(k) ? '[redacted]' : truncate(typeof v === 'object' ? JSON.stringify(v) : String(v), FIELD_TRUNCATE);
    L.push(`- **${k}**: ${val}`);
  }
  L.push('');
  return L;
}

/** Generic dump of every captured context object (mirrors ContextCard). */
function renderContexts(contexts: Record<string, unknown>): string[] {
  const L: string[] = [];
  const cards = Object.entries(contexts).filter(([, v]) => v && typeof v === 'object');
  if (!cards.length) return L;
  L.push('## Contexts (all captured)', '');
  for (const [name, v] of cards) {
    L.push(`### ${name}`);
    const entries = Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'type');
    if (!entries.length) L.push('- _(empty)_');
    for (const [k, val] of entries) {
      L.push(`- **${k}**: ${truncate(typeof val === 'object' ? JSON.stringify(val) : String(val ?? ''), FIELD_TRUNCATE)}`);
    }
    L.push('');
  }
  return L;
}

/** Platform-aware environment summary: browser/device for JS, runtime/command for PHP. */
function renderEnvironment(platform: AgentPlatform, event: EventDto | null): string[] {
  if (!event) return [];
  const ctx = (event.contexts ?? {}) as Record<string, Record<string, unknown>>;
  const L = ['## Environment', ''];
  const browser = ctx['browser'];
  const os = ctx['os'];
  const device = ctx['device'];
  const runtime = ctx['runtime'];
  if (platform === 'javascript' || browser) {
    if (browser?.['name']) L.push(`- **Browser**: ${String(browser['name'])}${browser['version'] ? ` ${String(browser['version'])}` : ''}`);
    if (os?.['name']) L.push(`- **OS**: ${String(os['name'])}${os['version'] ? ` ${String(os['version'])}` : ''}`);
    if (device && (device['family'] || device['model'])) L.push(`- **Device**: ${String(device['family'] ?? device['model'])}`);
  }
  if (platform === 'php' || runtime || event.tags?.['command']) {
    if (runtime?.['name']) L.push(`- **Runtime**: ${String(runtime['name'])}${runtime['version'] ? ` ${String(runtime['version'])}` : ''}`);
    else if (platform === 'php') L.push('- **Runtime**: PHP (no runtime context captured)');
    if (os?.['name']) L.push(`- **OS**: ${String(os['name'])}${os['version'] ? ` ${String(os['version'])}` : ''}`);
    if (event.tags?.['command']) L.push(`- **Artisan command**: \`${event.tags['command']}\` (re-run this to reproduce)`);
  }
  if (platform === 'unknown' && !browser && !runtime) {
    if (os?.['name']) L.push(`- **OS**: ${String(os['name'])}${os['version'] ? ` ${String(os['version'])}` : ''}`);
  }
  const sdk = event.sdk as Record<string, unknown> | null;
  if (sdk?.['name']) L.push(`- **SDK**: ${String(sdk['name'])}${sdk['version'] ? ` ${String(sdk['version'])}` : ''}`);
  L.push('');
  return L;
}

function renderSuspect(frames: NormalizedFrame[], componentStack?: NormalizedFrame[]): string[] {
  const L: string[] = [];
  if (!frames.length && !componentStack?.length) return L;
  const stackHasInApp = frames.some((f) => f.inApp);
  const componentSuspect = !stackHasInApp && componentStack?.some((f) => f.inApp)
    ? pickSuspectFrame(componentStack)
    : undefined;
  const suspect = componentSuspect ?? (frames.length ? pickSuspectFrame(frames) : undefined);
  if (!suspect) return L;
  L.push('## 🎯 Prime suspect', '');
  const loc = frameLoc(suspect);
  if (!suspect.inApp) {
    L.push(`- **Location**: \`${loc}\` — _thrown inside framework code; no app frame on this stack. The bug lives in the code that triggered this path (request, breadcrumbs, replay), not in this file._`);
  } else {
    L.push(`- **File**: \`${loc}\`${suspect.function ? ` — \`${suspect.function}\`` : ''}${componentSuspect ? ' _(React component)_' : ''}`);
  }
  if (suspect.githubUrl) L.push(`- **GitHub**: ${suspect.githubUrl}`);
  L.push(...frameContextBlock(suspect), '');
  return L;
}

export function buildAgentMarkdown(
  issue: IssueDto,
  event: EventDto | null,
  opts: AgentExportOptions = {},
): string {
  const { collapseVendorFrames = true, includeRequestBody = true, occurrenceLabel, links } = opts;
  const platform = inferPlatform(event);
  const platformLabel = platform === 'unknown' ? '' : ` · platform \`${platform === 'php' ? 'php-laravel' : 'javascript'}\``;
  const L: string[] = [];
  const exc = event?.exception;
  const frames: NormalizedFrame[] = exc?.frames ?? [];
  const componentStack: NormalizedFrame[] | undefined = exc?.componentStackFrames;

  L.push(`# 🐛 ${issue.title}`, '');
  L.push('## Summary');
  L.push(`- **Issue**: ${issue.shortId} · level \`${issue.level}\` · category \`${issue.category}\` · status \`${issue.status}\`${issue.isRegressed ? ' · **regressed**' : ''}${platformLabel}`);
  L.push(`- _(Issue title is the group fingerprint — the exact error of this occurrence is under "Error" below.)_`);
  if (issue.culprit) L.push(`- **Culprit**: \`${issue.culprit}\``);
  L.push(`- **Occurrences**: ${issue.timesSeen} (users affected: ${issue.usersAffected})${occurrenceLabel ? ` · exported occurrence: ${occurrenceLabel}` : ''}`);
  L.push(`- **First seen**: ${issue.firstSeen} · **Last seen**: ${issue.lastSeen}`);
  if (event) {
    L.push(`- **Event ID**: \`${event.id}\` · **at**: ${event.timestamp}`);
    L.push(`- **Handled**: ${event.handled} · **Environment**: ${event.environment}${event.release ? ` · **Release**: ${event.release}` : ''}`);
    if (event.transaction) L.push(`- **Transaction**: \`${event.transaction}\``);
    if (event.url) L.push(`- **URL**: ${event.url}`);
    if (event.traceId) L.push(`- **Trace ID**: \`${event.traceId}\``);
  }
  if (links?.issueUrl) L.push(`- **Issue link**: ${links.issueUrl}`);
  if (event?.traceId && links?.traceUrl) L.push(`- **Trace link**: ${links.traceUrl}`);
  if (links?.replayUrl) L.push(`- **Replay link**: ${links.replayUrl}`);
  if (links?.suspectCommits?.length) {
    L.push(`- **Suspect commits**:`);
    for (const c of links.suspectCommits.slice(0, 5)) {
      L.push(`  - [\`${c.sha.slice(0, 7)}\`](${c.url}) ${truncate(c.message.split('\n')[0], 100)} — ${c.author}`);
    }
  }
  L.push('');

  // Prime suspect first — the file the agent should open.
  L.push(...renderSuspect(frames, componentStack));

  // Request + user: the repro inputs.
  L.push(...renderRequest(event?.request ?? null, includeRequestBody));
  L.push(...renderUser(event?.user ?? null));

  if (exc?.type || exc?.value) {
    L.push('## Error (this occurrence)', '```', `${exc.type ?? 'Error'}: ${exc.value ?? issue.title}`, '```', '');
  }

  L.push(...renderTrace(frames, collapseVendorFrames));

  // React component stack (Next.js hydration/render errors) — separate from the JS stack.
  if (componentStack?.length) {
    L.push('## React component stack', '');
    L.push('_The component tree rendering when React raised this error (innermost first)._', '');
    L.push(...renderTrace(componentStack, false));
  }

  L.push(...renderBreadcrumbs(event?.breadcrumbs ?? []));
  L.push(...renderEnvironment(platform, event));
  L.push(...renderContexts((event?.contexts ?? {}) as Record<string, unknown>));

  const tags = derivedTags(issue, event);
  const tagKeys = Object.keys(tags);
  if (tagKeys.length) {
    L.push('## Tags', ...tagKeys.map((k) => `- ${k}: ${tags[k]}`), '');
  }

  const crashFrame = pickSuspectFrame(frames);
  const crashLoc = crashFrame ? frameLoc(crashFrame) : 'the top in-app frame';
  L.push('## Task for the AI agent');
  L.push(
    `You are an expert debugger. Identify the **root cause** of the error above and propose a **minimal fix** as a unified diff.`,
    `The crash originates at \`${crashLoc}\`${crashFrame?.contextLine ? `: \`${crashFrame.contextLine.trim()}\`` : ''}.`,
    `Use the HTTP request as repro input, the breadcrumbs as repro steps, and the source context to reason about state. Explain the fix briefly, then output the patch.`,
  );
  L.push('', '---', `_Exported from geniusDebug · ${issue.shortId}${event ? ` · event ${event.id}` : ''}_`);

  let doc = L.join('\n');
  if (doc.length > MAX_DOC) {
    doc = doc.slice(0, MAX_DOC) + '\n\n_(…truncated: document exceeded export cap)_';
  }
  return doc;
}
