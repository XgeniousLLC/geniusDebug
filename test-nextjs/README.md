# geniusDebug — local Next.js test app

A throwaway Next.js app that fires errors and records a session replay into a
**locally running** geniusDebug, so you can verify the full path
`browser → tunnel → ingest → worker → issue/replay` end to end.

Not part of the geniusDebug monorepo workspaces — it's a standalone project.

## 1. Start geniusDebug locally

From the repo root:

```bash
npm run dev      # api :4002 · ingest :4001 · workers · web :5173
```

Open the dashboard (http://localhost:5173), register/login, and create (or open) a
project. On the project **Setup guide** copy the **Sentry DSN** — it looks like:

```
http://<publicKey>@localhost:4001/<projectId>
```

## 2. Configure this test app

```bash
cd test-nextjs
npm install

# create .env.local with your DSN (paste the one from step 1):
cat > .env.local <<'EOF'
NEXT_PUBLIC_SENTRY_DSN=http://REPLACE_PUBLIC_KEY@localhost:4001/REPLACE_PROJECT_ID
GENIUSDEBUG_INGEST_HOST=http://localhost:4001
NEXT_PUBLIC_ENV=local-test
NEXT_PUBLIC_RELEASE=test-local
EOF
```

## 3. Run it

```bash
npm run dev      # → http://localhost:3100
```

Open **http://localhost:3100** and use the buttons:

- **Trigger errors** — render crash / handled / unhandled async / promise rejection.
- **Replay masking check** — type into the email + password fields, then fire an
  error. In the recorded replay the email is **readable**, the password is **masked**.
- **Generate replay activity** — click around to give the replay DOM to render.

Within a few seconds the issue appears in the dashboard; open it → **Replay** tab to
watch the recording.

## Replays need R2

Replay **playback** requires Cloudflare R2 configured on your local geniusDebug
(recordings are streamed to R2; the player fetches the blob back). Without R2 the
issue and replay metadata still appear, but the player shows a masked placeholder
("blob unavailable"). Configure R2 in the dashboard: **Settings → Integrations →
Cloudflare R2** (or set `R2_*` env on ingest/api/workers).

## Notes

- Uses `tunnelRoute: '/monitoring'` → same-origin POST → no CORS against local ingest.
- Replay masking mirrors `taskip-integration/sentry.client.config.ts`: only password
  inputs masked (`maskInputOptions.password: true`, `maskAllText/Inputs/blockAllMedia: false`).
- Sampling is set to `1.0` here **for testing** (always capture). Production
  (taskip-integration) uses conservative sampling + on-error-only replay.
- Port is **3100** (3000 is often taken). Change in `package.json` if needed.
