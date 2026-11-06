/** The same-code windows (SA 7.5): 5 s after ok, 30 s after a refusal, and a heads-up while it shows. */
import { SCAN_TIMING } from '../timing.ts';
import type { Ignore } from './types.ts';

export const IGNORE_CAP = 20;
const FOREVER = Number.MAX_SAFE_INTEGER;

export const pruneIgnore = (list: Ignore[], now: number): Ignore[] =>
  list.length === 0 || list.every((i) => i.until >= now)
    ? list
    : list.filter((i) => i.until >= now);

export const findIgnore = (list: Ignore[], sig: string, now: number): Ignore | undefined =>
  list.find((i) => i.sig === sig && i.until >= now);

/** Adds an entry for `sig`, replacing its old one. Keeps the newest `IGNORE_CAP`. */
export function addIgnore(list: Ignore[], entry: Ignore): Ignore[] {
  return [...list.filter((i) => i.sig !== entry.sig), entry].slice(-IGNORE_CAP);
}

export const acceptedIgnore = (sig: string, now: number): Ignore => ({
  sig,
  until: now + SCAN_TIMING.SAME_CODE_ACCEPTED_IGNORE,
  why: 'accepted',
});
export const refusedIgnore = (sig: string, now: number, headline: string): Ignore => ({
  sig,
  until: now + SCAN_TIMING.SAME_CODE_REFUSED_IGNORE,
  why: 'refused',
  headline,
});
/** A heads-up is "shown" while it is on screen. */
export const shownIgnore = (sig: string): Ignore => ({ sig, until: FOREVER, why: 'shown' });

/** A heads-up left the screen: its code stays ignored 5 s more. */
export const settleShown = (list: Ignore[], now: number): Ignore[] =>
  list.some((i) => i.why === 'shown' && i.until === FOREVER)
    ? list.map((i) =>
        i.why === 'shown' && i.until === FOREVER
          ? { ...i, until: now + SCAN_TIMING.SAME_CODE_ACCEPTED_IGNORE }
          : i,
      )
    : list;
