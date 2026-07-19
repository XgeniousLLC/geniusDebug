/**
 * Local test app — withSentryConfig. Sentry's own SaaS upload is DISABLED; this
 * app just exercises the geniusDebug ingest → worker → dashboard path locally.
 */
import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default withSentryConfig(nextConfig, {
  sourcemaps: { disable: true },
  release: { create: false },
  tunnelRoute: '/monitoring',
  silent: true,
  disableLogger: true,
});
