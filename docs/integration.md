# Integrate an app

geniusDebug speaks the **Sentry envelope protocol**, so **any Sentry SDK works against it unchanged** —
you only repoint the DSN. If your app already uses `@sentry/*`, integration is a config change, not a
rewrite. Nothing about geniusDebug may affect your app's performance: the SDK is async/best-effort and
gated by a remote kill switch.

## 1. Create a project & get the DSN

In geniusDebug → register (first user) or Settings → your project shows a **DSN**:

```
https://<publicKey>@<ingest-host>/<projectId>
```

The public key is **write-only** — it can send events but cannot read data. Safe to embed in a client
bundle.

## 2. Next.js (`@sentry/nextjs`) — the v1 target

If your Next.js app **already uses `@sentry/nextjs`**, change three things.

### a. Point the DSN at geniusDebug

```ts
// sentry.client.config.ts / sentry.server.config.ts / sentry.edge.config.ts
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, // = the geniusDebug DSN above
  tunnelRoute: '/monitoring',              // first-party forward, beats ad-blockers
  environment: process.env.NEXT_PUBLIC_ENV,
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: 0.1,                    // conservative — protect Core Web Vitals
  replaysOnErrorSampleRate: 1.0,            // on-error replay only
  replaysSessionSampleRate: 0,
});
```

### b. Disable Sentry's own SaaS source-map upload

geniusDebug uploads maps itself, so remove Sentry's org/project/authToken:

```js
// next.config.mjs
export default withSentryConfig(nextConfig, {
  sourcemaps: { disable: true },   // no Sentry SaaS upload
  release: { create: false },
  tunnelRoute: '/monitoring',
  // do NOT set org / project / authToken
});
```

### c. Add the tunnel route + upload maps on deploy

- Add a same-origin route that forwards the raw envelope to geniusDebug ingest (fail-fast, never blocks
  the app). Reference implementation: **`taskip-integration/app/monitoring/route.ts`**.
- Run geniusDebug's uploader in CI so frames symbolicate — see [Deploy without Docker §5](deploy.md).

!!! tip "Drop-in reference"
    The whole wiring (client/server/edge config, instrumentation, global-error, tunnel route, remote
    kill switch, `withSentryConfig`) is in **`taskip-integration/`** — copy it in and adjust paths.

## 3. Any other Sentry SDK (server-to-server)

Because ingest is envelope-based, **just set the SDK's DSN to a geniusDebug project DSN**. No tunnel,
no source maps for server platforms.

```ts
// @sentry/node (a Node/Nest service)
Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
```

```php
// Laravel (sentry/sentry-laravel) — v2, but the backend already supports it
// .env:  SENTRY_LARAVEL_DSN=https://<publicKey>@<ingest-host>/<projectId>
```

geniusDebug's pipeline is **platform-agnostic**: PHP/Node events group, get culprits, and render like
JS events; symbolication is skipped for non-JS (they already have real file paths). Laravel is
scheduled for **v2** (SRS §12) — client-config only, no backend change.

## 4. Remote kill switch (recommended)

Point your SDK gate at geniusDebug's config endpoint to disable/throttle it **without a redeploy**:

```
NEXT_PUBLIC_GENIUS_CONFIG_URL=https://<ingest-host>/api/<projectId>/config?sentry_key=<publicKey>
```

Returns `{ enabled, tracesSampleRate, replaysOnErrorSampleRate, replaysSessionSampleRate }`. If it's
unreachable the SDK stays silent and never throws into your app. Flip **Settings → Disable ingest** and
your app stops sending. Reference: `taskip-integration/lib/genius-remote-config.ts`.

## 5. Verify

1. Trigger a handled error in your app.
2. It appears in geniusDebug → **Issues** within seconds (grouped, with culprit).
3. Open it → **symbolicated** stack (once maps are uploaded), highlights, trace ID.
4. Link your **GitHub** repo (Settings) → stack frames deep-link to the exact commit + line.

## 6. Pinning & upgrades

- Pin the Sentry SDK **major** version. The envelope payload is the contract geniusDebug's ingest
  parses; an SDK major upgrade is a reviewed change.
- geniusDebug ignores unknown envelope item types safely, so minor SDK updates are low-risk.

## 7. Migrating off Sentry SaaS

- Swap `NEXT_PUBLIC_SENTRY_DSN` (and any server DSN) to the geniusDebug DSN.
- Remove Sentry `authToken` / `org` / `project` and set `sourcemaps.disable: true`.
- Add geniusDebug's uploader to CI.
- Everything else (breadcrumbs, contexts, tracing, replay) is emitted by the same SDK and understood by
  geniusDebug's ingest — no app code changes.
