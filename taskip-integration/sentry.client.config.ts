/**
 * Taskip — client Sentry init pointed at geniusDebug (FR-SDK-1/2/3/6/7/9).
 * Drop into Taskip's repo root. The golden rule: this must NEVER affect Taskip's
 * performance — sampling is conservative, Replay is on-error only, and the whole
 * SDK is gated by a remote kill switch (FR-SDK-8) so it can be disabled without a
 * redeploy. The SDK is already async/non-blocking; we only constrain it.
 */
import * as Sentry from '@sentry/nextjs';
import { getGeniusRemoteConfig } from './lib/genius-remote-config';

const cfg = getGeniusRemoteConfig(); // cached; never throws into the app

if (cfg.enabled && process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, // points at geniusDebug (FR-SDK-2)
    tunnelRoute: '/monitoring', // first-party forwarder, defeats ad-blockers (FR-SDK-3)
    environment: process.env.NEXT_PUBLIC_ENV ?? 'vercel-production', // FR-SDK-5
    release: process.env.NEXT_PUBLIC_RELEASE, // git SHA — matches uploaded maps (FR-SDK-5)

    // Conservative sampling to protect Core Web Vitals (FR-SDK-6 / NFR-PERF-1/2).
    tracesSampleRate: cfg.tracesSampleRate ?? 0.1,
    replaysOnErrorSampleRate: cfg.replaysOnErrorSampleRate ?? 1.0,
    replaysSessionSampleRate: cfg.replaysSessionSampleRate ?? 0,

    integrations: [
      Sentry.replayIntegration({
        maskAllText: true, // PII off by default (FR-SDK-7 / FR-RPL-4)
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],

    // Scrub tokens/PII and drop unwanted events before they leave the browser.
    beforeSend(event) {
      if (event.request?.headers) delete event.request.headers['authorization'];
      if (event.request?.cookies) delete event.request.cookies;
      return event;
    },
  });
}
