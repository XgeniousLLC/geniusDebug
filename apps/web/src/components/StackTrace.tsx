import * as React from 'react';
import type { NormalizedFrame } from '@geniusdebug/shared';
import { ChevronDownIcon } from './icons';

/**
 * Stack frame block (brief §4 / FR-MAP-3/5/6, FR-GH-3): monospace, in-app frames
 * highlighted vs framework frames, source-context lines around the crash line,
 * "Open in GitHub" per in-app frame. Crashing frame first.
 */
export function StackTrace({ frames }: { frames: NormalizedFrame[] }) {
  if (!frames || frames.length === 0) {
    return <div className="text-small text-text-muted">No stack trace on this event.</div>;
  }
  // Sentry order is oldest→newest; show the crashing frame first.
  const ordered = [...frames].reverse();
  const appCount = ordered.filter((f) => f.inApp).length;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-caption text-text-faint">
        <span>
          {ordered.length} frame{ordered.length === 1 ? '' : 's'}
        </span>
        {appCount > 0 && (
          <>
            <span>·</span>
            <span className="text-accent">{appCount} in-app</span>
          </>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        {ordered.map((f, i) => (
          <Frame key={i} f={f} defaultOpen={f.inApp} last={i === ordered.length - 1} />
        ))}
      </div>
    </div>
  );
}

function splitPath(p: string): { dir: string; base: string } {
  const clean = p.replace(/^webpack-internal:\/\/\/(\(.*?\)\/)?/, '').replace(/^\.\//, '');
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? { dir: '', base: clean } : { dir: clean.slice(0, idx + 1), base: clean.slice(idx + 1) };
}

function Frame({ f, defaultOpen, last }: { f: NormalizedFrame; defaultOpen: boolean; last: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const { dir, base } = splitPath(f.absPath ?? f.filename ?? '<anonymous>');
  const hasContext = f.contextLine != null || (f.preContext?.length ?? 0) > 0;
  return (
    <div className={`${!last ? 'border-b border-border' : ''} ${f.inApp ? 'border-l-2 border-l-accent' : ''}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2 ${f.inApp ? 'bg-surface' : 'bg-surface/30'}`}
      >
        <div className="flex min-w-0 items-baseline gap-2 font-mono text-mono">
          <ChevronDownIcon size={14} className={`shrink-0 text-text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
          {f.function && <span className="shrink-0 text-accent">{f.function}</span>}
          <span className="min-w-0 truncate">
            {dir && <span className="text-text-faint">{dir}</span>}
            <span className={f.inApp ? 'text-text' : 'text-text-faint'}>{base}</span>
            {f.lineno != null && (
              <span className="text-text-faint">
                :{f.lineno}
                {f.colno != null ? `:${f.colno}` : ''}
              </span>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {f.githubUrl && (
            <a
              href={f.githubUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-caption text-accent hover:underline"
            >
              GitHub ↗
            </a>
          )}
          {f.inApp ? (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-caption text-accent">in-app</span>
          ) : (
            <span className="text-caption text-text-faint">system</span>
          )}
        </div>
      </button>
      {open &&
        (hasContext ? (
          <pre className="overflow-x-auto border-t border-border bg-bg px-0 py-1 font-mono text-mono leading-6">
            {(f.preContext ?? []).map((l, i) => (
              <CodeLine key={`pre-${i}`} n={f.lineno != null ? f.lineno - (f.preContext!.length - i) : null} text={l} />
            ))}
            {f.contextLine != null && <CodeLine n={f.lineno ?? null} text={f.contextLine} crash />}
            {(f.postContext ?? []).map((l, i) => (
              <CodeLine key={`post-${i}`} n={f.lineno != null ? f.lineno + i + 1 : null} text={l} />
            ))}
          </pre>
        ) : (
          // No source context (minified / system frame) — still show the frame details.
          <div className="border-t border-border bg-bg px-3 py-2 font-mono text-mono">
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {f.function && <Detail k="function" v={f.function} />}
              <Detail k="file" v={f.absPath ?? f.filename ?? '<anonymous>'} />
              {f.lineno != null && <Detail k="line" v={`${f.lineno}${f.colno != null ? `:${f.colno}` : ''}`} />}
            </div>
            <div className="mt-1.5 text-caption text-text-faint">
              {f.inApp ? 'No source context — upload source maps to see the code here.' : 'System / minified frame — no source available.'}
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
      <span className={`w-3 shrink-0 ${crash ? 'text-level-error' : 'text-transparent'}`}>▸</span>
      <span className={`whitespace-pre pr-3 ${crash ? 'text-text' : 'text-text-muted'}`}>{text}</span>
    </div>
  );
}
