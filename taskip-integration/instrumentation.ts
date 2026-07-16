/**
 * Taskip — Next.js instrumentation hook (FR-SDK-1). Loads the right Sentry config
 * per runtime so client, server, and edge errors are all captured.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Forward React render errors from Server Components (Next 15+).
export { captureRequestError as onRequestError } from '@sentry/nextjs';
