/** Human-readable Issue short ID, e.g. JAVASCRIPT-NEXTJS-Z (FR-GRP-3). */
export function buildShortId(projectPlatform: string, eventPlatform: string, seq: number): string {
  const parts = (projectPlatform || eventPlatform || 'javascript').toUpperCase().split('-');
  const base = parts.length > 1 ? parts.join('-') : `${eventPlatform.toUpperCase()}-APP`;
  return `${base}-${seq.toString(36).toUpperCase()}`;
}
