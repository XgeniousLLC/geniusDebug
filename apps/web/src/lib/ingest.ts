/**
 * Ingest is a separate app on its own domain (Coolify/Traefik serve it on 443).
 * Never derive the DSN host from the web hostname + a raw container port — that
 * port is not publicly reachable. Set VITE_INGEST_ORIGIN in prod; dev falls back
 * to localhost:4001.
 */
export function ingestHost(): string {
  const origin =
    import.meta.env.VITE_INGEST_ORIGIN ??
    `${window.location.protocol}//${window.location.hostname}:4001`;
  return origin.replace(/^https?:\/\//, '');
}

/** Build a public write-only DSN for a project + public key. */
export function buildDsn(publicKey: string, projectId: string): string {
  return `https://${publicKey}@${ingestHost()}/${projectId}`;
}
