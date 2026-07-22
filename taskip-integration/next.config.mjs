/**
 * Taskip — next.config with withSentryConfig (FR-BLD-1). Sentry's OWN SaaS upload
 * is DISABLED: geniusDebug's own uploader (scripts/upload-sourcemaps.mjs) handles
 * maps → R2. Do NOT set Sentry org/project/authToken.
 *
 * IMPORTANT: sourcemaps.disable MUST be false (or omitted) so the Sentry webpack
 * plugin injects Debug IDs into the built JS + .map files. Without Debug IDs the
 * worker cannot match error events to source maps for symbolication (FR-MAP-3).
 * The upload to Sentry is skipped because no org/project/authToken are set.
 */
import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ...Taskip's existing config
};

export default withSentryConfig(nextConfig, {
  // sourcemaps.disable is intentionally NOT set to true — we need the plugin
  // to inject Debug IDs (debug_id in .map, debugId comment in .js) even though
  // we don't upload to Sentry. The upload is skipped automatically when
  // org/project/authToken are absent.
  release: { create: false }, // release is created by geniusDebug artifact registration
  tunnelRoute: '/monitoring', // matches app/monitoring/route.ts (FR-SDK-3)
  silent: true,
  disableLogger: true, // tree-shake Sentry logger to keep bundle small (FR-SDK-9)
});
