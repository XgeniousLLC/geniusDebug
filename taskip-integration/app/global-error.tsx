'use client';
/**
 * Taskip — global React error boundary wired to Sentry (FR-SDK-4). Route-level
 * error.tsx boundaries should do the same `Sentry.captureException(error)`.
 */
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <h2>Something went wrong.</h2>
      </body>
    </html>
  );
}
