import { z } from 'zod';
import { sessionJson } from './session-fetch.ts';
import { resetSessionGone } from './session-gone.ts';

/**
 * The Workbench token (design §2.3): minted per org from the session, pinned to Test, 15 minutes,
 * renewed at 12 while the tab is visible. It lives in this module's memory only: never storage, a
 * cookie, a URL, the DOM or anything shown.
 */
export const TOKEN_PATH = '/api/v1/workbench/token';
export const RENEW_MS = 12 * 60_000;
const MARGIN_MS = 3 * 60_000;
const FLOOR_MS = 60_000;
/** The lifetime assumed when the server's clock cannot be read from the mint response. */
const DEFAULT_TTL_MS = 15 * 60_000;

const MintSchema = z.object({
  token: z.string().min(1),
  orgId: z.string(),
  mode: z.literal('test'),
  expiresAt: z.number(),
  subject: z.enum(['sandbox_key', 'member']),
});

interface Held {
  value: string;
  /** Device time: the server's lifetime counted from when this device received the mint. */
  renewAt: number;
}

const held = new Map<string, Held>();
const inflight = new Map<string, Promise<string>>();
const subs = new Set<() => void>();
/** Bumped by `forgetTokens`: a mint begun before it never lands. */
let generation = 0;

/**
 * When a token is due, on this device's clock: 12 minutes in, or 3 before its end when the server
 * gave less, never sooner than a minute. `ttl` is the server's own `expiresAt` minus its own now
 * (the mint response's `Date`), so a device clock that is wrong changes nothing.
 */
export function renewAt(now: number, ttl: number): number {
  return now + Math.max(FLOOR_MS, Math.min(RENEW_MS, ttl - MARGIN_MS));
}

/** The server's remaining lifetime for a mint response; the usual 15 minutes without its `Date`. */
export function serverTtl(expiresAt: number, dateHeader: string | null): number {
  const serverNow = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isFinite(serverNow) ? expiresAt - serverNow : DEFAULT_TTL_MS;
}

/** Called after every mint: the renewal timer plans again from the new due time. */
export function onTokenMinted(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

async function mint(orgId: string, csrf: string): Promise<string> {
  const started = generation;
  let date: string | null = null;
  const body = await sessionJson(TOKEN_PATH, MintSchema, {
    method: 'POST',
    body: { orgId },
    csrf,
    onResponse: (res) => {
      date = res.headers.get('date');
    },
  });
  // A token for another org, or not Test, is never used.
  if (body.orgId !== orgId) throw new Error('Workbench token for another organization.');
  // The person changed while it was minting: it belongs to nobody now.
  if (started !== generation) throw new Error('Workbench token request superseded.');
  held.set(orgId, {
    value: body.token,
    renewAt: renewAt(Date.now(), serverTtl(body.expiresAt, date)),
  });
  // A mint worked, so the session is there.
  resetSessionGone();
  for (const sub of subs) sub();
  return body.token;
}

/**
 * The org's token, minted first when none is held or it is due (or `force`, the renewal timer's).
 * One mint at a time per org.
 */
export function workbenchToken(orgId: string, csrf: string, force = false): Promise<string> {
  const current = held.get(orgId);
  if (!force && current && Date.now() < current.renewAt) return Promise.resolve(current.value);
  let pending = inflight.get(orgId);
  if (!pending) {
    pending = mint(orgId, csrf).finally(() => inflight.delete(orgId));
    inflight.set(orgId, pending);
  }
  return pending;
}

/** Milliseconds until the org's token is due, or null when none is held. */
export function dueIn(orgId: string, now = Date.now()): number | null {
  const current = held.get(orgId);
  return current ? Math.max(0, current.renewAt - now) : null;
}

/** The server refused `used`: forget it, so the next call mints. A newer token stays. */
export function dropToken(orgId: string, used?: string): void {
  if (used !== undefined && held.get(orgId)?.value !== used) return;
  held.delete(orgId);
}

/** Sign-out and principal changes: no token outlives its session. */
export function forgetTokens(): void {
  generation++;
  held.clear();
  inflight.clear();
}
