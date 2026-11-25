import { DEMO_WORDS, type DemoWords } from '../../../generated/demo-words.ts';
import { type Config, DEFAULT_ANCHOR } from './config.ts';
import { Rng } from './prng.ts';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Fixed standard-time offsets: no DST tables, so output never depends on the runtime's zone data. */
const LOCALE_ZONE = {
  'en-US': { tz: 'America/Los_Angeles', offset: -8, currency: 'USD', lat: 47.6, lng: -122.3 },
  'en-GB': { tz: 'Europe/London', offset: 0, currency: 'GBP', lat: 51.5, lng: -0.1 },
  'de-DE': { tz: 'Europe/Berlin', offset: 1, currency: 'EUR', lat: 52.5, lng: 13.4 },
  'fr-FR': { tz: 'Europe/Paris', offset: 1, currency: 'EUR', lat: 48.9, lng: 2.3 },
  'es-ES': { tz: 'Europe/Madrid', offset: 1, currency: 'EUR', lat: 40.4, lng: -3.7 },
} as const;

export interface Ctx {
  c: Config;
  words: DemoWords;
  /** Anchor midnight, epoch ms (UTC fields). */
  t0: number;
  zone: (typeof LOCALE_ZONE)[Config['locale']];
}

export function ctxOf(c: Config): Ctx {
  return {
    c,
    words: DEMO_WORDS[c.locale],
    t0: Date.parse(`${c.anchor ?? DEFAULT_ANCHOR}T00:00:00Z`),
    zone: LOCALE_ZONE[c.locale],
  };
}

/** The stream for one record: independent of count and of every other record. */
export function recordRng(c: Config, ref: string): Rng {
  return new Rng(`${c.seed}|${c.dataset}|${c.locale}|${ref}`);
}

export function worldRng(c: Config, topic = 'world'): Rng {
  return new Rng(`${c.seed}|${c.dataset}|${c.locale}|${topic}`);
}

const cache = new Map<string, unknown>();
/** Shared entities are rebuilt only when their inputs change. */
export function memo<T>(key: string, make: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  if (cache.size >= 32) cache.clear();
  const value = make();
  cache.set(key, value);
  return value;
}

export const worldKey = (c: Config, topic = 'world') =>
  `${c.seed}|${c.dataset}|${c.locale}|${c.anchor ?? ''}|${topic}`;

/** `YYYY-MM-DD`. */
export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** UTC instant, no milliseconds. */
export const isoZ = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** A wall-clock time (`ms` read with UTC fields) written with its zone offset in hours. */
export function isoWall(ms: number, offset: number): string {
  const sign = offset < 0 ? '-' : '+';
  const hh = String(Math.abs(offset)).padStart(2, '0');
  return `${new Date(ms).toISOString().slice(0, 19)}${sign}${hh}:00`;
}

export const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** An injective 6-digit-ish number from a 1-based index: `lo + (n * 48271) mod span`, span coprime to 48271. */
export const scatter = (n: number, lo: number, span: number) => lo + ((n * 48271) % span);

export function updatedAt(x: Ctx, lastChange: number): string {
  return isoZ(x.t0 + lastChange * HOUR);
}
