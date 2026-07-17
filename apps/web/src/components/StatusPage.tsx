import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { GeniusDebugIcon } from '../brand/GeniusDebugIcon';
import { Button } from './ui';

/**
 * Full-page status screen (404 / 403 / generic) — themed to the design tokens,
 * works light + dark. Big ghosted status code behind a titled message + actions.
 */
export function StatusPage({
  code,
  title,
  message,
  actions,
}: {
  code: string;
  title: string;
  message: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full items-center justify-center px-6 py-16">
      <div className="relative w-full max-w-lg text-center">
        {/* Ghosted status code */}
        <div
          aria-hidden
          className="pointer-events-none select-none text-[140px] font-bold leading-none tracking-tight text-text/[0.06] sm:text-[180px]"
        >
          {code}
        </div>

        <div className="-mt-10 flex flex-col items-center gap-3 sm:-mt-14">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-surface text-accent">
            <GeniusDebugIcon size={22} />
          </div>
          <h1 className="text-h1 font-semibold text-text">{title}</h1>
          <p className="max-w-md text-small text-text-muted">{message}</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            {actions ?? (
              <>
                <Button variant="primary" size="sm" onClick={() => navigate('/dashboard')}>
                  Go to dashboard
                </Button>
                <Button variant="secondary" size="sm" onClick={() => navigate(-1)}>
                  Go back
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
