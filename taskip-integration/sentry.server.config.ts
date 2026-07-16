/** Taskip — server runtime Sentry init (FR-SDK-1). SSR/route-handler errors. */
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_ENV ?? 'vercel-production',
    release: process.env.NEXT_PUBLIC_RELEASE,
    tracesSampleRate: 0.1,
    // No Replay on the server; browser-only (FR-RPL / FR-PHP-5 note).
  });
}
