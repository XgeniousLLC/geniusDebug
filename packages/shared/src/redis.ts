/**
 * ioredis connection options derived from a REDIS_URL.
 *
 * BullMQ blocking connections require `maxRetriesPerRequest: null`.
 * When the URL is `rediss://` (TLS) we accept self-signed certs, because managed
 * Redis (Coolify, DO, Heroku, …) terminate TLS with a private/self-signed CA on a
 * trusted private network. Scoped to the Redis client only — never global
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, which would weaken every other TLS call
 * (R2 / SES / GitHub) in the same process.
 */
export function redisOptions(
  url: string = process.env.REDIS_URL ?? 'redis://localhost:6379',
): { maxRetriesPerRequest: null; tls?: { rejectUnauthorized: false } } {
  const base = { maxRetriesPerRequest: null as null };
  return url.startsWith('rediss://')
    ? { ...base, tls: { rejectUnauthorized: false } }
    : base;
}
