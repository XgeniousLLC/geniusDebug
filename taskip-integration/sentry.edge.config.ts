/** Taskip — edge runtime Sentry init (FR-SDK-1). Middleware/edge route errors. */
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_ENV ?? 'vercel-production',
    release: process.env.NEXT_PUBLIC_RELEASE,
    tracesSampleRate: 0.1,
  });
}
