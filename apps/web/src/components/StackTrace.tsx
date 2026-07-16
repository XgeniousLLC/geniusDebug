import * as React from 'react';
import type { NormalizedFrame } from '@geniusdebug/shared';

/**
 * Stack frame block (brief §4 / FR-MAP-3/5/6, FR-GH-3): monospace, in-app frames
 * highlighted vs framework frames, source-context lines around the crash line,
 * "Open in GitHub" per in-app frame.
 */
export function StackTrace({ frames }: { frames: NormalizedFrame[] }) {
  if (!frames || frames.length === 0) {
    return <div className="text-small text-text-muted">No stack trace on this event.</div>;
  }
  // Sentry order is oldest→newest; show crashing frame first.
  const ordered = [...frames].reverse();
  return (
    <div className="flex flex-col gap-2">
      {ordered.map((f, i) => (
        <Frame key={i} f={f} defaultOpen={f.inApp} />
      ))}
    </div>
  );
}

function Frame({ f, defaultOpen }: { f: NormalizedFrame; defaultOpen: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const path = f.absPath ?? f.filename ?? '<anonymous>';
  const hasContext = f.contextLine != null || (f.preContext?.length ?? 0) > 0;
  return (
    <div
      className={`overflow-hidden rounded-md border ${
        f.inApp ? 'border-border bg-surface' : 'border-border/60 bg-surface/40'
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-surface-2"
      >
        <div className="flex min-w-0 items-baseline gap-2 font-mono text-mono">
          <span className={`truncate ${f.inApp ? 'text-text' : 'text-text-faint'}`}>{path}</span>
          {f.function && <span className="text-accent">in {f.function}</span>}
          {f.lineno != null && (
            <span className="text-text-faint">
              :{f.lineno}
              {f.colno != null ? `:${f.colno}` : ''}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!f.inApp && <span className="text-caption text-text-faint">framework</span>}
          {f.inApp && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-caption text-accent">in-app</span>}
          {f.githubUrl && (
            <a
              href={f.githubUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-caption text-accent hover:underline"
            >
              Open in GitHub ↗
            </a>
          )}
        </div>
      </button>
      {open && hasContext && (
        <pre className="overflow-x-auto border-t border-border bg-bg/50 px-3 py-2 font-mono text-mono leading-5">
          {(f.preContext ?? []).map((l, i) => (
            <div key={`pre-${i}`} className="text-text-faint">
              <span className="mr-3 inline-block w-8 select-none text-right text-text-faint">
                {f.lineno != null ? f.lineno - (f.preContext!.length - i) : ''}
              </span>
              {l}
            </div>
          ))}
          {f.contextLine != null && (
            <div className="bg-level-error/10 text-text">
              <span className="mr-3 inline-block w-8 select-none text-right text-level-error">{f.lineno}</span>
              {f.contextLine}
            </div>
          )}
          {(f.postContext ?? []).map((l, i) => (
            <div key={`post-${i}`} className="text-text-faint">
              <span className="mr-3 inline-block w-8 select-none text-right text-text-faint">
                {f.lineno != null ? f.lineno + i + 1 : ''}
              </span>
              {l}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
