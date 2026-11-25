import { DiagramError, type Tone } from './spec.ts';

/** Shared drawing helpers. Everything here is pure and deterministic. */

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Coordinates print with at most one decimal, so output bytes never depend on float noise. */
export const n = (v: number): string => String(Math.round(v * 10) / 10);

export type Face = 'sans' | 'semibold' | 'mono';

const NARROW = new Set("il.,:;'|!ftjrI()[]/ ");
const WIDE = new Set('mwMW@%');

/**
 * Text width in px from fixed font metrics, not from the browser. Deliberately a little wide
 * (Rubik and JetBrains Mono both run wide), so a label that fits here fits on any device.
 */
export function measure(s: string, size: number, face: Face): number {
  if (face === 'mono') return s.length * size * 0.61;
  let em = 0;
  for (const ch of s) {
    if (NARROW.has(ch)) em += 0.32;
    else if (WIDE.has(ch)) em += 0.88;
    else if (ch >= 'A' && ch <= 'Z') em += 0.68;
    else if (ch >= '0' && ch <= '9') em += 0.6;
    else em += 0.57;
  }
  return em * size * (face === 'semibold' ? 1.07 : 1) * 1.03;
}

/** Fails the build when a label does not fit its box. */
export function mustFit(what: string, s: string, size: number, face: Face, max: number): number {
  const w = measure(s, size, face);
  if (w > max) {
    throw new DiagramError(
      `${what} "${s}" is ${Math.ceil(w)}px wide, the box holds ${Math.floor(max)}px`,
    );
  }
  return w;
}

export const toneClass = (t: Tone | undefined): string => `dg-tone-${t ?? 'neutral'}`;

export interface Drawn {
  w: number;
  h: number;
  body: string;
}

/** Container widths (px) under which the figure swaps to its list; the first tier above 80% of the drawing. */
export const TIERS = [520, 600, 680, 760, 840, 920] as const;
export const tierFor = (w: number): number => {
  const tier = TIERS.find((t) => t >= w * 0.8 + 40);
  if (!tier) {
    throw new DiagramError(
      `drawing is ${Math.ceil(w)}px wide; at 0.8 scale it needs more than ${TIERS[TIERS.length - 1]}px. Cut a lane or shorten labels`,
    );
  }
  return tier;
};

export function svgShell(uid: string, title: string, desc: string, d: Drawn): string {
  const head = (cls: string, path: string) =>
    `<marker id="${uid}-${cls}" class="dg-marker" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path class="dg-${cls}" d="${path}"/></marker>`;
  return (
    `<svg class="dg-svg" viewBox="0 0 ${n(d.w)} ${n(d.h)}" width="${n(d.w)}" height="${n(d.h)}" role="img" aria-labelledby="${uid}-title" aria-describedby="${uid}-desc" aria-details="${uid}-list" xmlns="http://www.w3.org/2000/svg">` +
    `<title id="${uid}-title">${esc(title)}</title><desc id="${uid}-desc">${esc(desc)}</desc>` +
    `<defs>${head('head', 'M0 0 10 5 0 10z')}${head('head-open', 'M1 1 8 5 1 9')}</defs>` +
    `${d.body}</svg>`
  );
}
