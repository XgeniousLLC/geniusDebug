# geniusDebug — Brand assets

Implemented from the Claude Design project **"Frontend design brief"** (`geniusDebug Icon.dc.html`). The palette here **is** the design-system palette in `docs/frontend-design-brief.md §2` — these are the same tokens; keep them in sync.

## The mark
A monitoring **scope** (ring) watching a **live signal** (EKG-style pulse), with the caught **error** as a red dot. Three ideas:

- **Scope ring** — the observability lens, always watching the app (`accent` #6C5FC7).
- **Live pulse** — the real-time event stream / heartbeat (white on the tile).
- **The catch** — the caught error, in `level-error` red (#E5484D), sitting at the low point of the pulse.

Tile gradient: `accent` **#6C5FC7 → #7B2CBF** `level-fatal` (top-left → bottom-right). Geometry is a fixed `120×120` viewBox, tile corner radius `28`.

## Files
| File | Use |
|---|---|
| `icon.svg` | Primary app icon — gradient tile + inner bevel + ring + pulse + red dot. |
| `favicon.svg` | Browser tab / ≤16px — **ring dropped**; pulse + red dot carry the mark (thicker strokes). |
| `icon-monochrome.svg` | Single-color, **tintable** via CSS `color` / `currentColor`. For one-color contexts. |
| `icon-glyph.svg` | Ring + pulse + dot, **no tile** — for inline use on a surface. |
| `GeniusDebugIcon.tsx` | React component (`variant`: `primary` \| `favicon` \| `mono` \| `glyph`; `size`). Unique gradient id per instance. Plus `GeniusDebugWordmark`. |

## Usage
```tsx
import { GeniusDebugIcon, GeniusDebugWordmark } from '@/brand/GeniusDebugIcon';

<GeniusDebugIcon size={40} />                 // primary tile
<GeniusDebugIcon size={16} variant="favicon" />
<GeniusDebugIcon size={24} variant="mono" style={{ color: '#EDEDF2' }} />
<GeniusDebugWordmark size={28} />             // sidebar / top-bar lockup
```
Web app: use `favicon.svg` as the tab icon; the tab reads **"geniusDebug — Issues"** (see design brief §6/§3).

## Scaling
Designed to hold at `128 · 64 · 40 · 32 · 24 · 16`. At `16px` use the **favicon** variant (no ring) so the pulse + dot stay legible.

## Rules
- Don't recolor the tile gradient or move the red dot off the pulse's low point — the "caught error" is the whole idea.
- Keep the red dot in `level-error` (#E5484D); it's the one semantic color in the mark.
- On light surfaces use the primary tile as-is (it carries its own background) or the `mono` variant tinted to `text` (#1A1A22).
