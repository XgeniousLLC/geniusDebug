/**
 * Taskip — next.config with withSentryConfig (FR-BLD-1). Sentry's OWN SaaS upload
 * is DISABLED: geniusDebug's own uploader (scripts/upload-sourcemaps.mjs) handles
 * maps → R2. Do NOT set Sentry org/project/authToken.
 */
import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ...Taskip's existing config
};

export default withSentryConfig(nextConfig, {
  // No org/project/authToken → no Sentry SaaS upload.
  sourcemaps: { disable: true }, // maps handled by geniusDebug uploader (FR-BLD-1)
  release: { create: false }, // release is created by geniusDebug artifact registration
  tunnelRoute: '/monitoring', // matches app/monitoring/route.ts (FR-SDK-3)
  silent: true,
  disableLogger: true, // tree-shake Sentry logger to keep bundle small (FR-SDK-9)
});
