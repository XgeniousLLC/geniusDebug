/**
 * Coarse issue category for filtering / the Warnings view (GD-134). Platform-agnostic
 * heuristics over level + exception type + title/culprit. Keep the set small and stable.
 */
export type IssueCategory = 'error' | 'warning' | 'performance' | 'security' | 'network' | 'ui' | 'other';

export function classifyCategory(input: {
  level: string;
  type?: string | null;
  title?: string | null;
  culprit?: string | null;
}): IssueCategory {
  const hay = `${input.type ?? ''} ${input.title ?? ''} ${input.culprit ?? ''}`.toLowerCase();

  if (/\b(csp|cors|xss|csrf|security|unsafe|mixed content|blocked by)\b/.test(hay)) return 'security';
  if (/\b(timeout|timed out|slow|deadline|performance|lcp|inp|cls|long task|jank)\b/.test(hay)) return 'performance';
  if (/\b(fetch|network|xhr|http|econn|dns|socket|failed to load|net::|429|502|503|504)\b/.test(hay)) return 'network';
  if (/\b(hydrat|render|reconcil|react|dom|jsx|element type|component)\b/.test(hay)) return 'ui';

  if (input.level === 'warning') return 'warning';
  if (input.level === 'fatal' || input.level === 'error') return 'error';
  if (input.level === 'info' || input.level === 'debug') return 'other';
  return 'error';
}
