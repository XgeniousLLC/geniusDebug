/**
 * Local test app — browser Sentry init (Next 15.3+ / Sentry 8.x location).
 * Next.js loads `instrumentation-client.ts` for the client runtime; the older
 * `sentry.client.config.ts` is deprecated and its options weren't fully applied
 * (input text recorded empty despite maskAllInputs:false — GD-141). Init lives
 * here now. Replay is set for TESTING: always records; only passwords masked.
 */
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    tunnelRoute: '/monitoring',
    environment: process.env.NEXT_PUBLIC_ENV ?? 'local-test',
    release: process.env.NEXT_PUBLIC_RELEASE ?? 'test-local',

    tracesSampleRate: 1.0,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 1.0,

    integrations: [
      Sentry.replayIntegration({
        // Sentry (and every replay tool) masks INPUT VALUES at record time — proven
        // by Sentry's own product masking email+password. The real values never reach
        // the recording, so we match Sentry's default: inputs render as length-
        // preserving asterisks (you can see a field was filled) while page text stays
        // readable (GD-141).
        maskAllText: false,
        maskAllInputs: true,
        blockAllMedia: false,
      }),
    ],

    beforeSend(event) {
      if (event.request?.headers) delete event.request.headers['authorization'];
      if (event.request?.cookies) delete event.request.cookies;
      return event;
    },
  });
}
