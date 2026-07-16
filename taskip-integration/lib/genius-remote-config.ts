/**
 * Taskip — remote kill switch / runtime config (FR-SDK-8 / NFR-PERF-4).
 * Taskip fetches a small cached config so geniusDebug can be throttled or fully
 * disabled WITHOUT a Taskip redeploy. If the config endpoint is unreachable the
 * SDK stays SILENT and never throws into the app (fail-safe, NFR-PERF-8).
 *
 * Backed by geniusDebug's project.ingestEnabled + config (Settings kill switch).
 */
export interface GeniusRemoteConfig {
  enabled: boolean;
  tracesSampleRate?: number;
  replaysOnErrorSampleRate?: number;
  replaysSessionSampleRate?: number;
}

const FAILSAFE: GeniusRemoteConfig = { enabled: false }; // if unknown → stay off

let cached: GeniusRemoteConfig | null = null;

/** Synchronous accessor used at init; refresh() warms the cache out of band. */
export function getGeniusRemoteConfig(): GeniusRemoteConfig {
  return cached ?? { enabled: true }; // optimistic default; refresh() can disable
}

export async function refresh(): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_GENIUS_CONFIG_URL;
    if (!url) return;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      cached = FAILSAFE;
      return;
    }
    cached = (await res.json()) as GeniusRemoteConfig;
  } catch {
    cached = FAILSAFE; // unreachable → disable, never throw (NFR-PERF-8)
  }
}
