# Taskip → geniusDebug integration (reference)

Drop-in `@sentry/nextjs` wiring for Taskip, pointed at geniusDebug. Reference files —
copy into Taskip's repo and adjust paths. Satisfies SRS §5.1/§5.1a (FR-SDK-1..9, FR-BLD-1).

## Files
| File | Purpose | SRS |
|---|---|---|
| `sentry.client.config.ts` | Browser init: DSN, tunnelRoute, on-error replay, PII scrub, kill-switch gate | FR-SDK-1/2/3/6/7 |
| `sentry.server.config.ts` / `sentry.edge.config.ts` | SSR + edge capture | FR-SDK-1 |
| `instrumentation.ts` | Loads the right runtime config; `onRequestError` | FR-SDK-1/4 |
| `app/global-error.tsx` | React render errors → `captureException` | FR-SDK-4 |
| `app/monitoring/route.ts` | First-party **tunnel** forwarder → geniusDebug ingest, fail-fast | FR-SDK-3 / FR-BLD-4 |
| `lib/genius-remote-config.ts` | Remote **kill switch**; fail-safe if unreachable | FR-SDK-8 / NFR-PERF-4/8 |
| `next.config.mjs` | `withSentryConfig` with Sentry SaaS upload **disabled** | FR-BLD-1 |

## Env (Taskip)
```
NEXT_PUBLIC_SENTRY_DSN=https://<publicKey>@<geniusDebug-ingest-host>/<projectId>
NEXT_PUBLIC_ENV=vercel-production
NEXT_PUBLIC_RELEASE=$VERCEL_GIT_COMMIT_SHA
NEXT_PUBLIC_GENIUS_CONFIG_URL=https://<ingest-host>/api/<projectId>/config?sentry_key=<publicKey>
GENIUSDEBUG_INGEST_HOST=https://<ingest-host>
```

## Deploy (source maps, automatic — no manual step)
Run geniusDebug's uploader as a post-build step (Vercel) or GitHub Action:
```
node scripts/upload-sourcemaps.mjs   # inject Debug IDs → R2 → register index → strip maps
```
Env for the uploader (CI secrets, never committed): `GENIUSDEBUG_ORG_TOKEN`, `GENIUSDEBUG_PROJECT_ID`,
`R2_*`, `RELEASE=$VERCEL_GIT_COMMIT_SHA`. Get the **org upload token** once from geniusDebug
Settings → issue token.

## Session Replay playback requires R2 (server-side)
The client config already records replays (`replaysOnErrorSampleRate: 1.0`). But **playback in the
geniusDebug dashboard needs Cloudflare R2 connected**, because the rrweb recording blob is stored
there — not in Postgres. In production (multiple containers) the ingest service streams every
`replay_recording` to R2 and the api reads it back; without R2 the blob falls back to the ingest
container's local disk, which the api container cannot read → the player shows "no recording blob".

If replays list but don't play in production, check, in order:
1. **R2 is connected** — Settings → Integrations → Cloudflare R2 → Test returns ok.
2. **ingest + api were redeployed** after connecting R2 (they resolve R2 creds at boot).
3. **`APP_ENCRYPTION_KEY` is identical** on ingest and api (a mismatch means ingest encrypts the
   R2 secret with one key and api can't decrypt it → both silently fall back). Set the same
   32-byte hex value on every service.

The recording endpoint reports the exact reason it couldn't play (`reason` field): "no recording
blob in R2" (R2 was off when ingested) vs "blob unavailable (R2 unconfigured, wrong encryption key,
or decode failed)".

## Golden rule
This never blocks or throws into Taskip. Sampling is conservative, Replay is on-error only,
the tunnel fails fast, and the whole thing is gated by the remote kill switch — flip it off in
geniusDebug Settings and Taskip stops sending with no redeploy (FR-SDK-8).
