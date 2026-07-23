#!/usr/bin/env node
/**
 * geniusDebug deploy-time source-map uploader (SRS §4.3, §5.1a, FR-BLD-2/3, FR-MAP-1/2).
 *
 * Runs automatically in the deploy build (Vercel post-build step or GitHub Actions).
 * Flow, no manual step:
 *   1. inject Debug IDs into built JS + .map (via @sentry/cli or unplugin)
 *   2. upload the .map artifacts DIRECTLY to Cloudflare R2 (S3 API), keyed by
 *      projectId + debugId, tagged with release (git SHA) + repo/commit
 *   3. register the lightweight artifact index with the geniusDebug API
 *      (POST /api/:projectId/releases/:release/artifacts) using the SECRET org
 *      upload token — never the public DSN (NFR-SEC-2)
 *   4. STRIP the .map files from public deploy output so they never reach users
 *
 * Secrets (R2 keys, org upload token) come from the build env, never committed
 * (FR-BLD-3). Fails the deploy loudly if any upload fails, so a release is never
 * left without maps.
 *
 * This is the reference implementation / contract. Wire @sentry/cli + the R2 S3
 * client (@aws-sdk/client-s3) in CI. Kept dependency-light here on purpose.
 */
import { readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const {
  GENIUSDEBUG_API = 'http://localhost:4002',
  GENIUSDEBUG_ORG_TOKEN, // SECRET — from CI env
  GENIUSDEBUG_PROJECT_ID,
  R2_BUCKET,
  RELEASE = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA,
  BUILD_DIR = '.next',
} = process.env;

function fail(msg) {
  console.error(`[upload-sourcemaps] FAILED: ${msg}`);
  process.exit(1); // fail the deploy loudly (FR-BLD-3)
}

async function findMaps(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findMaps(p)));
    else if (entry.name.endsWith('.map')) out.push(p);
  }
  return out;
}

/**
 * Read the Debug ID that Sentry's webpack plugin injected for this bundle.
 *
 * IMPORTANT (found the hard way — see taskip-client incident, Sprint 36): the
 * `//# debugId=<uuid>` COMMENT in the .map JSON is only ever written by the
 * plugin's own upload-preparation step, which requires SENTRY_AUTH_TOKEN — and
 * this guide deliberately tells you NOT to set that (no SaaS upload). Without
 * it, the .map's `debugId`/`debug_id` field is simply never populated, and
 * falling back to a content hash means it can NEVER match a real event's
 * debug_id — every symbolication lookup silently fails forever, with no error
 * anywhere in the pipeline to point at why.
 *
 * What IS always present, auth-independent, is the debug-ID marker webpack's
 * BannerPlugin injects into the actual JS file — `sentry-dbid-<uuid>` — which
 * is also what the browser SDK itself reads into debug_meta.images[].debug_id.
 * Read that from the sibling .js file instead. Falls back to the .map's own
 * field (works if you DO have a Sentry auth token configured) and finally to
 * a content hash (non-Sentry builds).
 */
async function debugIdFor(buf, mapPath) {
  try {
    const jsPath = mapPath.replace(/\.map$/, '');
    const jsContent = await readFile(jsPath, 'utf8');
    const marker = jsContent.match(/sentry-dbid-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    if (marker) return marker[1];
  } catch { /* JS file missing/unreadable — fall through */ }
  try {
    const map = JSON.parse(buf.toString('utf8'));
    if (map.debugId) return map.debugId;
    if (map['debug_id']) return map['debug_id'];
  } catch { /* not JSON — fall through */ }
  return createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

let _s3;
async function s3() {
  if (!_s3) {
    const { S3Client } = await import('@aws-sdk/client-s3');
    _s3 = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3;
}

async function uploadToR2(debugId, buf) {
  // Large maps go STRAIGHT to R2 (keyed by projectId + debugId); only the light
  // index passes through the geniusDebug API (§4.3, FR-BLD-2).
  const r2Key = `sourcemaps/${GENIUSDEBUG_PROJECT_ID}/${debugId}.map`;
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await s3();
  await client.send(
    new PutObjectCommand({ Bucket: R2_BUCKET, Key: r2Key, Body: buf, ContentType: 'application/json' }),
  );
  return { r2Key };
}

async function main() {
  if (!GENIUSDEBUG_ORG_TOKEN) fail('GENIUSDEBUG_ORG_TOKEN (secret) is required');
  if (!GENIUSDEBUG_PROJECT_ID) fail('GENIUSDEBUG_PROJECT_ID is required');
  if (!RELEASE) fail('RELEASE (git SHA) is required');
  if (!R2_BUCKET) fail('R2_BUCKET is required');

  const maps = await findMaps(BUILD_DIR).catch((e) => fail(`cannot read ${BUILD_DIR}: ${e.message}`));
  if (maps.length === 0) fail(`no .map files under ${BUILD_DIR}`);

  const artifacts = [];
  for (const mapPath of maps) {
    const buf = await readFile(mapPath);
    const debugId = await debugIdFor(buf, mapPath);
    const checksum = createHash('sha1').update(buf).digest('hex');
    const { r2Key } = await uploadToR2(debugId, buf);
    artifacts.push({ debugId, r2Key, checksum, size: buf.length });
  }

  // Register the index (Debug IDs, R2 keys, release, commit, repo) with the API.
  const res = await fetch(
    `${GENIUSDEBUG_API}/api/${GENIUSDEBUG_PROJECT_ID}/releases/${RELEASE}/artifacts`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${GENIUSDEBUG_ORG_TOKEN}` },
      body: JSON.stringify({ release: RELEASE, commitSha: RELEASE, artifacts }),
    },
  ).catch((e) => fail(`register failed: ${e.message}`));
  if (!res.ok) fail(`register returned ${res.status}`);

  // Strip maps from public output so they never reach end users (FR-BLD-2).
  for (const mapPath of maps) await unlink(mapPath).catch(() => {});
  console.log(`[upload-sourcemaps] ${artifacts.length} maps → R2, registered release ${RELEASE}, stripped from output.`);
}

main();
