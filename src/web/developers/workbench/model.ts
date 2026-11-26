import type {
  DeveloperHomeKey,
  DeveloperProgress,
} from '../../../shared/contracts/developer-home.ts';

/** The track as the page shows it: sign-in, then the server's four steps. */
export const TRACK_STEPS = [
  { id: 'signin', label: 'Sign in' },
  { id: 'sandbox', label: 'Sandbox' },
  { id: 'call', label: 'First call' },
  { id: 'change', label: 'Change it' },
  { id: 'webhook', label: 'Hear back' },
] as const;
export type TrackId = (typeof TRACK_STEPS)[number]['id'];

export interface Tick {
  id: TrackId;
  label: string;
  at: number | null;
  current: boolean;
}

export function ticksOf(p: DeveloperProgress): Tick[] {
  const at: Record<TrackId, number | null> = {
    signin: p.startedAt,
    sandbox: p.sandboxAt,
    call: p.passAt,
    change: p.changeAt,
    webhook: p.webhookAt,
  };
  return TRACK_STEPS.map((s) => ({ ...s, at: at[s.id], current: s.id === p.next }));
}

const two = (n: number) => String(n).padStart(2, '0');

/** `3:42`; `1:02:05` past an hour. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

export type Source = 'key' | 'try' | 'all';
export const SOURCES: readonly { id: Source; label: string }[] = [
  { id: 'key', label: 'Yours' },
  { id: 'try', label: 'Run here' },
  { id: 'all', label: 'All' },
];

/** An SVG polyline over `w` × `h`, the highest value at the top; flat at the bottom when all are zero. */
export function sparkPoints(values: readonly number[], w: number, h: number): string {
  const top = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  return values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / top) * (h - 2)).toFixed(1)}`)
    .join(' ');
}

/** Share of the limit used, 0 to 100; 0 with no limit. */
export const meter = (n: number, limit: number | null): number =>
  limit ? Math.min(100, Math.round((n / limit) * 100)) : 0;

/** `Rolling`: a roll's overlap is running. `Expired`: still listed, so it can be rolled. */
export function keyState(k: DeveloperHomeKey, now: number): 'active' | 'rolling' | 'expired' {
  if (k.expiresAt !== null && k.expiresAt <= now) return 'expired';
  return k.retireAt !== null ? 'rolling' : 'active';
}

/** The secret's start with an ellipsis: all the page ever shows of a key. */
export const masked = (k: Pick<DeveloperHomeKey, 'secretPrefix'>): string => `${k.secretPrefix}_…`;

/** The host of a URL endpoint, for its row. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // Endpoint URLs are validated on write; a malformed one shows as it is stored.
    return url;
  }
}
