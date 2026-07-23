import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NormalizedFrame } from '@geniusdebug/shared';
import { hasUsableFramePath } from '@geniusdebug/shared';
import { api } from '../lib/api';
import { ChevronDownIcon } from './icons';

interface FrameSource {
  available: boolean;
  path?: string;
  lines?: { n: number; text: string; crash: boolean }[];
  githubUrl?: string;
  reason?: string;
}
const SOURCE_EXT = /\.(mjs|cjs|jsx?|tsx?|vue|svelte|php)$/;
const MAPPABLE_EXT = /\.(mjs|cjs|jsx?|tsx?|vue|svelte)$/; // source-map-eligible (JS only)

/**
 * Sentry-style stack trace (brief §4 / FR-MAP-3/5/6, FR-GH-3): crashing frame
 * first, a "Crashed in" summary, `file:line:col in function` headers with In-App
 * badges + copy/GitHub actions, syntax-highlighted source context, and
 * consecutive system frames collapsed behind a "Show N more frames" toggle.
 */
export function StackTrace({ frames, shortId }: { frames: NormalizedFrame[]; shortId?: string }) {
  if (!frames || frames.length === 0) {
    return <div className="text-small text-text-muted">No stack trace on this event.</div>;
  }
  const ordered = [...frames].reverse(); // crashing frame first
  // The innermost frame is sometimes one the SDK couldn't resolve a real file
  // for (e.g. sentry-php's "Unknown"/line-0 placeholder on a shutdown-captured
  // fatal with no backtrace to the actual trigger) — featuring that as "Crashed
  // in" is actively misleading. Prefer the nearest frame with a real path.
  const crash = ordered.find(hasUsableFramePath) ?? ordered[0];

  // Group consecutive system frames so they collapse together (Sentry behavior).
  const groups: { system: boolean; frames: { f: NormalizedFrame; idx: number }[] }[] = [];
  ordered.forEach((f, idx) => {
    const system = !f.inApp;
    const last = groups[groups.length - 1];
    if (last && last.system === system) last.frames.push({ f, idx });
    else groups.push({ system, frames: [{ f, idx }] });
  });

  const appCount = ordered.filter((f) => f.inApp).length;

  return (
    <div>
      {/* Crashed-in summary */}
      <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-caption text-text-muted">
        <span className="min-w-0 truncate">
          Crashed in {crash.inApp ? '' : 'non-app: '}
          <span className="font-mono text-text">
            {shortFile(crash.absPath ?? crash.filename)}
            {crash.lineno ? `:${crash.lineno}${crash.colno != null ? `:${crash.colno}` : ''}` : ''}
          </span>
          {crash.function && (
            <span>
              {' '}in <span className="font-mono text-text">{crash.function}</span>
            </span>
          )}
        </span>
        {crash.githubUrl && (
          <a href={crash.githubUrl} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-text-faint hover:text-text" title="Open this line in GitHub">
            <GithubGlyph />
          </a>
        )}
      </div>
      <div className="mb-2 text-caption text-text-faint">
        {ordered.length} frame{ordered.length === 1 ? '' : 's'}
        {appCount > 0 && <span className="text-accent"> · {appCount} in-app</span>}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {groups.map((g, gi) =>
          g.system && g.frames.length > 1 ? (
            <SystemGroup key={gi} frames={g.frames} lastGroup={gi === groups.length - 1} shortId={shortId} />
          ) : (
            g.frames.map(({ f }, i) => (
              <Frame key={`${gi}-${i}`} f={f} defaultOpen={f.inApp} last={gi === groups.length - 1 && i === g.frames.length - 1} shortId={shortId} />
            ))
          ),
        )}
      </div>
    </div>
  );
}

/** Collapsed run of system frames → "Show N more frames". */
function SystemGroup({ frames, lastGroup, shortId }: { frames: { f: NormalizedFrame; idx: number }[]; lastGroup: boolean; shortId?: string }) {
  const [open, setOpen] = React.useState(false);
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className={`flex w-full items-center gap-2 bg-surface/40 px-3 py-2 text-caption text-text-muted hover:bg-surface-2 ${!lastGroup ? 'border-b border-border' : ''}`}
      >
        <ChevronDownIcon size={13} className="-rotate-90 text-text-faint" />
        Show {frames.length} more frame{frames.length === 1 ? '' : 's'}
      </button>
    );
  }
  return (
    <>
      {frames.map(({ f }, i) => (
        <Frame key={i} f={f} defaultOpen={false} last={lastGroup && i === frames.length - 1} shortId={shortId} />
      ))}
    </>
  );
}

function Frame({ f, defaultOpen, last, shortId }: { f: NormalizedFrame; defaultOpen: boolean; last: boolean; shortId?: string }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const file = shortFile(f.absPath ?? f.filename);
  const hasContext = f.contextLine != null || (f.preContext?.length ?? 0) > 0;
  const rawPath = f.absPath ?? f.filename ?? '';
  const canFetch = !!shortId && !hasContext && SOURCE_EXT.test(shortFile(rawPath)) && !shortFile(rawPath).includes('node_modules/');
  const mappable = MAPPABLE_EXT.test(shortFile(rawPath));
  // Lazily pull the file from the linked GitHub repo when the event carried no source.
  const src = useQuery({
    queryKey: ['frame-source', shortId, rawPath, f.lineno],
    queryFn: () => api<FrameSource>(`/issues/${shortId}/source?path=${encodeURIComponent(rawPath)}&line=${f.lineno ?? 1}`),
    enabled: open && canFetch,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(`${f.absPath ?? f.filename ?? ''}:${f.lineno ?? ''}:${f.colno ?? ''}${f.function ? ` in ${f.function}` : ''}`);
  };
  return (
    <div className={`${!last ? 'border-b border-border' : ''} ${f.inApp ? 'border-l-2 border-l-accent' : ''}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2 ${f.inApp ? 'bg-surface' : 'bg-surface/30'}`}
      >
        <div className="flex min-w-0 items-center gap-2 font-mono text-mono">
          <ChevronDownIcon size={13} className={`shrink-0 text-text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
          <span className={`min-w-0 truncate ${f.inApp ? 'text-text' : 'text-text-faint'}`}>
            {file}
            {!!f.lineno && (
              <span className="text-text-faint">
                :{f.lineno}
                {f.colno != null ? `:${f.colno}` : ''}
              </span>
            )}
          </span>
          {f.function && (
            <span className="shrink-0 text-text-faint">
              in <span className="text-accent">{f.function}</span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span onClick={copy} className="text-text-faint hover:text-text" title="Copy frame">
            <CopyGlyph />
          </span>
          {f.githubUrl && (
            <a href={f.githubUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-text-faint hover:text-text" title="Open in GitHub">
              <GithubGlyph />
            </a>
          )}
          {f.inApp ? (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-caption font-medium text-accent">In App</span>
          ) : (
            <span className="text-caption text-text-faint">system</span>
          )}
        </div>
      </button>
      {open &&
        (hasContext ? (
          <pre className="overflow-x-auto border-t border-border bg-bg px-0 py-1.5 font-mono text-mono leading-6">
            {(f.preContext ?? []).map((l, i) => (
              <CodeLine key={`pre-${i}`} n={f.lineno != null ? f.lineno - (f.preContext!.length - i) : null} text={l} />
            ))}
            {f.contextLine != null && <CodeLine n={f.lineno ?? null} text={f.contextLine} crash />}
            {(f.postContext ?? []).map((l, i) => (
              <CodeLine key={`post-${i}`} n={f.lineno != null ? f.lineno + i + 1 : null} text={l} />
            ))}
          </pre>
        ) : src.data?.available && src.data.lines ? (
          // Source pulled live from the linked GitHub repo (FR-MAP-6).
          <pre className="overflow-x-auto border-t border-border bg-bg px-0 py-1.5 font-mono text-mono leading-6">
            {src.data.lines.map((l) => (
              <CodeLine key={l.n} n={l.n} text={l.text} crash={l.crash} />
            ))}
          </pre>
        ) : (
          <div className="border-t border-border bg-bg px-3 py-2 font-mono text-mono">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {f.function && <Detail k="function" v={f.function} />}
              <Detail k="file" v={f.absPath ?? f.filename ?? '<anonymous>'} />
              {!!f.lineno && <Detail k="line" v={`${f.lineno}${f.colno != null ? `:${f.colno}` : ''}`} />}
            </div>
            <div className="mt-1.5 text-caption text-text-faint">
              {!hasUsableFramePath(f)
                ? "No file for this frame — the SDK couldn't resolve one (common for a PHP shutdown-captured fatal with no full backtrace to the trigger). Linking a repo won't help here; check breadcrumbs/tags for context instead."
                : src.isFetching
                  ? 'Loading source from GitHub…'
                  : canFetch && src.data && !src.data.available
                    ? `No source: ${src.data.reason ?? 'unavailable'}.`
                    : f.inApp
                      ? mappable
                        ? 'No source context — link a GitHub repo or upload source maps to see the code here.'
                        : 'No source context — link a GitHub repo to see the code here.'
                      : 'System / minified frame — no source available.'}
            </div>
          </div>
        ))}
    </div>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-text-faint">{k}</span>
      <span className="truncate text-text-muted">{v}</span>
    </span>
  );
}

function CodeLine({ n, text, crash }: { n: number | null; text: string; crash?: boolean }) {
  return (
    <div className={`flex ${crash ? 'bg-level-error/10' : ''}`}>
      <span className={`inline-block w-12 shrink-0 select-none px-3 text-right ${crash ? 'text-level-error' : 'text-text-faint'}`}>{n ?? ''}</span>
      <span className="whitespace-pre pr-4">{highlight(text)}</span>
    </div>
  );
}

// ------------------------- helpers -------------------------

function shortFile(p?: string | null): string {
  if (!p) return '<anonymous>';
  return p.replace(/^webpack-internal:\/\/\/(\(.*?\)\/)?/, '').replace(/^\.\//, '');
}

// Lightweight JS/TS syntax highlighter for source-context lines.
const KW =
  'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|throw|try|catch|finally|await|async|void|delete|import|export|default|from|as|class|extends|super|typeof|instanceof|in|of|yield|null|undefined|true|false|this';
const TOKEN = new RegExp(`(//.*$)|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|(\\b(?:${KW})\\b)|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*(?=\\s*\\())`, 'g');

function highlight(line: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  let key = 0;
  while ((m = TOKEN.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const [full, comment, str, kw, num, fn] = m;
    if (comment) out.push(<span key={key++} className="italic text-text-faint">{full}</span>);
    else if (str) out.push(<span key={key++} className="text-status-resolved">{full}</span>);
    else if (kw) out.push(<span key={key++} className="text-level-fatal">{full}</span>);
    else if (num) out.push(<span key={key++} className="text-level-warning">{full}</span>);
    else if (fn) out.push(<span key={key++} className="text-accent">{full}</span>);
    last = m.index + full.length;
    if (full.length === 0) TOKEN.lastIndex++; // guard against zero-width
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function CopyGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
function GithubGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.1-1.47-1.1-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
    </svg>
  );
}
