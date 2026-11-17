import type { CSSProperties } from 'react';
import { isDarkBackground, parseColor } from '@/shared/pass-view/color.ts';

/**
 * A blueprint's identity is its pass: background, text and label colours become the variables the
 * stage, glyph and glow read. Nothing is keyed by slug; a new blueprint brings its own. On a light
 * (paper) background the glow takes the label colour, where the background itself would not show.
 */
export function blueprintVars(passJson: Record<string, unknown> | undefined): CSSProperties {
  const bg = passJson?.backgroundColor;
  const fg = passJson?.foregroundColor;
  const label = passJson?.labelColor;
  if (typeof bg !== 'string' || typeof fg !== 'string' || typeof label !== 'string') return {};
  if (!parseColor(bg) || !parseColor(fg) || !parseColor(label)) return {};
  return {
    '--bp': bg,
    '--bp-fg': fg,
    '--bp-label': label,
    '--bp-glow': isDarkBackground(bg, 0.5) ? bg : label,
  } as CSSProperties;
}
