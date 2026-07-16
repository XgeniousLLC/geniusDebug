import * as React from 'react';

/**
 * geniusDebug brand mark.
 *
 * Concept: a monitoring **scope** (ring) watching a **live signal** (EKG pulse),
 * with the caught **error** marked as a red dot in `level-error` (#E5484D).
 * Tile gradient runs `accent` (#6C5FC7) -> `level-fatal` (#7B2CBF).
 * Imported from the Claude Design project "Frontend design brief".
 * Palette source of truth: docs/frontend-design-brief.md §2.
 */

const PULSE = 'M27 62 L49 62 L57 45 L66 85 L73 57 L81 62 L93 62';

export type IconVariant = 'primary' | 'favicon' | 'mono' | 'glyph';

export interface GeniusDebugIconProps extends Omit<React.SVGProps<SVGSVGElement>, 'children'> {
  /** Rendered px (viewBox is fixed 120). Default 32. */
  size?: number;
  /** primary = gradient tile + ring; favicon = tile, no ring (>= readable at 16px);
   *  mono = single-color (currentColor), tintable; glyph = ring+pulse, no tile. */
  variant?: IconVariant;
  title?: string;
}

export function GeniusDebugIcon({
  size = 32,
  variant = 'primary',
  title = 'geniusDebug',
  ...rest
}: GeniusDebugIconProps) {
  // Unique gradient id per instance — avoids SVG <defs> id collisions when many icons render.
  const uid = React.useId().replace(/:/g, '');
  const gradId = `gd-${uid}`;

  const svg = {
    width: size,
    height: size,
    viewBox: '0 0 120 120',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    role: 'img' as const,
    'aria-label': title,
    ...rest,
  };

  if (variant === 'mono') {
    return (
      <svg {...svg}>
        <rect x="3" y="3" width="114" height="114" rx="26" fill="none" stroke="currentColor" strokeWidth="5" />
        <circle cx="60" cy="60" r="31" stroke="currentColor" strokeWidth="6.5" opacity="0.35" />
        <path d={PULSE} stroke="currentColor" strokeWidth="7.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="66" cy="85" r="8" fill="currentColor" />
      </svg>
    );
  }

  if (variant === 'glyph') {
    return (
      <svg {...svg}>
        <circle cx="60" cy="60" r="31" stroke="#6C5FC7" strokeWidth="6.5" opacity="0.55" />
        <path d={PULSE} stroke="#EDEDF2" strokeWidth="7.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="66" cy="85" r="8" fill="#E5484D" />
      </svg>
    );
  }

  const isFavicon = variant === 'favicon';
  return (
    <svg {...svg}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="120" y2="120" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6C5FC7" />
          <stop offset="1" stopColor="#7B2CBF" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" rx="28" fill={`url(#${gradId})`} />
      {!isFavicon && (
        <rect x="1.5" y="1.5" width="117" height="117" rx="26.5" fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth="3" />
      )}
      {!isFavicon && <circle cx="60" cy="60" r="31" stroke="#fff" strokeWidth="6.5" opacity="0.3" />}
      <path d={PULSE} stroke="#fff" strokeWidth={isFavicon ? 9 : 7.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="66" cy="85" r={isFavicon ? 9 : 8} fill="#E5484D" />
    </svg>
  );
}

export interface GeniusDebugWordmarkProps {
  /** Icon px. Text scales with it. Default 28. */
  size?: number;
  className?: string;
}

/** Icon + "genius" (text) + "Debug" (muted). */
export function GeniusDebugWordmark({ size = 28, className }: GeniusDebugWordmarkProps) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10, letterSpacing: '-0.4px' }}
    >
      <GeniusDebugIcon size={size} />
      <span style={{ fontWeight: 600, fontSize: Math.round(size * 0.72) }}>
        genius<span style={{ color: '#9A9AA8' }}>Debug</span>
      </span>
    </span>
  );
}

export default GeniusDebugIcon;
