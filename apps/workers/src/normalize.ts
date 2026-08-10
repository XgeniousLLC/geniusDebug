import type { SentryEventPayload, NormalizedEvent, NormalizedFrame, IssueLevel } from '@geniusdebug/shared';
import { computeCulprit, pageOf } from '@geniusdebug/shared';
import { decodeReactError } from './react-errors';

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

  // React component stack (recoverable errors — hydration mismatches etc.),
  // sent by the client's hydrateRoot instrumentation as
  // contexts.react.componentStack. Parsed into frames here so symbolication
  // can resolve them to original component files/lines.
  const reactCtx = p.contexts?.react as { componentStack?: unknown } | undefined;
  const componentStackFrames =
    typeof reactCtx?.componentStack === 'string'
      ? parseComponentStack(reactCtx.componentStack)
      : undefined;

  // Culprit = top in-app frame's module/abs_path (FR-GRP-3); framework-only
  // stacks headline the page (transaction, else URL pathname) instead of a
  // node_modules path. Refreshed post-symbolication in symbolicate.ts.
  const culprit = computeCulprit(frames, undefined, pageOf(p.transaction, p.request?.url));

  // Expand production "Minified React error #NNN" values into the real
  // developer-facing message (hydration mismatches etc.) so the issue title
  // says what actually went wrong instead of pointing at react.dev.
  const rawValue = exc?.value;
  const exceptionValue = rawValue ? decodeReactError(rawValue) ?? rawValue : rawValue;

  const ts =
    typeof p.timestamp === 'number'
      ? new Date(p.timestamp * 1000).toISOString()
      : p.timestamp ?? new Date().toISOString();

  // Keep the code_file ↔ debug_id PAIRS, not just the ids: symbolication must
  // resolve each frame only through its own chunk's map (see DebugImage docs).
  const debugImages = (p.debug_meta?.images ?? [])
    .filter(
      (img): img is { code_file: string; debug_id: string } =>
        typeof img.debug_id === 'string' && typeof img.code_file === 'string',
    )
    .map((img) => ({ codeFile: img.code_file, debugId: img.debug_id }));

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
    exceptionValue,
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
    // SDK versions vary: some stamp `contexts.replay.replay_id`, others (e.g.
    // sentry.javascript.nextjs 10.x) only stamp `tags.replayId` on the error event.
    replayId:
      (p.contexts?.replay as { replay_id?: string } | undefined)?.replay_id ?? p.tags?.replayId,
    debugIds,
    debugImages,
    componentStackFrames,
  };
}

/**
 * Parse a React componentStack string into frames. Production lines look like
 * `    at ComponentName (https://host/_next/static/chunks/x.js:1:2345)` —
 * same shape as an Error stack, ordered innermost (mismatching component)
 * first. Lines without a location (`at div`, host components) are kept as
 * function-only frames. Stored innermost-LAST to match NormalizedFrame order
 * (stack traces are outermost-first; the UI reverses for display).
 */
export function parseComponentStack(componentStack: string): NormalizedFrame[] | undefined {
  const frames: NormalizedFrame[] = [];
  for (const line of componentStack.split('\n')) {
    const m = /^\s*at\s+(.+?)(?:\s+\((.+?)(?::(\d+))(?::(\d+))?\))?\s*$/.exec(line);
    if (!m) continue;
    frames.push({
      function: m[1],
      absPath: m[2],
      filename: m[2],
      lineno: m[3] ? Number(m[3]) : undefined,
      colno: m[4] ? Number(m[4]) : undefined,
      inApp: false, // re-derived after symbolication (resolveFrame / sanitize)
    });
  }
  if (frames.length === 0) return undefined;
  return frames.reverse(); // innermost last (NormalizedFrame convention)
}
