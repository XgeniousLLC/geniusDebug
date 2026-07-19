'use client';
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body style={{ fontFamily: 'system-ui', padding: 40 }}>
        <h2>Render error captured → sent to geniusDebug.</h2>
        <p>{error.message}</p>
        <a href="/">← back</a>
      </body>
    </html>
  );
}
