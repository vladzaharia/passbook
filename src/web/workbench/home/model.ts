import type { DeveloperHomeKey } from '../../../shared/contracts/developer-home.ts';

const two = (n: number) => String(n).padStart(2, '0');

/** `3:42`; `1:02:05` past an hour. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** An SVG polyline over `w` × `h`, the highest value at the top; flat at the bottom when all are zero. */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  const top = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / top) * (h - 2)).toFixed(1)}`)
    .join(' ');
}

/** `Rolling`: a roll's overlap is running. `Expired`: still listed, so it can be rolled. */
export function keyState(k: DeveloperHomeKey, now: number): 'active' | 'rolling' | 'expired' {
  if (k.expiresAt !== null && k.expiresAt <= now) return 'expired';
  return k.retireAt !== null ? 'rolling' : 'active';
}

/** The secret's start with an ellipsis: all the page ever shows of a key. */
export const masked = (k: Pick<DeveloperHomeKey, 'secretPrefix'>): string => `${k.secretPrefix}_…`;
