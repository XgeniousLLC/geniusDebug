import type { SentryEventPayload, NormalizedEvent, NormalizedFrame, IssueLevel } from '@geniusdebug/shared';
import { computeCulprit } from '@geniusdebug/shared';

function coerceMessage(m: SentryEventPayload['message']): string | undefined {
  if (!m) return undefined;
  if (typeof m === 'string') return m;
  return m.formatted ?? m.message;
}

function toBreadcrumbs(b: SentryEventPayload['breadcrumbs']): Array<Record<string, unknown>> {
  if (!b) return [];
  if (Array.isArray(b)) return b;
  return b.values ?? [];
}

/**
 * Map Sentry event fields to the geniusDebug model (FR-WRK-6). Platform-agnostic
 * (FR-WRK-7): reads `platform` and never assumes JavaScript.
 */
export function normalizeEvent(p: SentryEventPayload): NormalizedEvent {
  const exc = p.exception?.values?.[p.exception.values.length - 1];
  const frames: NormalizedFrame[] = (exc?.stacktrace?.frames ?? []).map((f) => ({
    filename: f.filename,
    absPath: f.abs_path,
    function: f.function,
    module: f.module,
    lineno: f.lineno,
    colno: f.colno,
    inApp: f.in_app ?? false,
    preContext: f.pre_context,
    contextLine: f.context_line,
    postContext: f.post_context,
  }));

  // Culprit = top in-app frame's module/abs_path (FR-GRP-3).
  const culprit = computeCulprit(frames);

  const ts =
    typeof p.timestamp === 'number'
      ? new Date(p.timestamp * 1000).toISOString()
      : p.timestamp ?? new Date().toISOString();

  const debugIds = (p.debug_meta?.images ?? [])
    .map((img) => img.debug_id)
    .filter((x): x is string => typeof x === 'string');

  return {
    eventId: (p.event_id ?? '').replace(/-/g, ''),
    platform: p.platform ?? 'javascript',
    level: (p.level ?? 'error') as IssueLevel,
    handled: exc?.mechanism?.handled ?? true,
    timestamp: ts,
    transaction: p.transaction,
    url: p.request?.url,
    release: p.release,
    environment: p.environment ?? 'production',
    message: coerceMessage(p.message),
    exceptionType: exc?.type,
    exceptionValue: exc?.value,
    culprit,
    frames,
    fingerprintOverride: p.fingerprint,
    contexts: {
      browser: p.contexts?.browser,
      os: p.contexts?.os,
      device: p.contexts?.device,
    },
    request: p.request as Record<string, unknown> | undefined,
    user: p.user as Record<string, unknown> | undefined,
    tags: p.tags ?? {},
    breadcrumbs: toBreadcrumbs(p.breadcrumbs),
    sdk: p.sdk,
    traceId: p.contexts?.trace?.trace_id,
    spanId: p.contexts?.trace?.span_id,
    replayId: (p.contexts?.replay as { replay_id?: string } | undefined)?.replay_id,
    debugIds,
  };
}
