/** Local test app — server runtime Sentry init (SSR / route-handler errors). */
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_ENV ?? 'local-test',
    release: process.env.NEXT_PUBLIC_RELEASE ?? 'test-local',
    tracesSampleRate: 1.0,
  });
}
