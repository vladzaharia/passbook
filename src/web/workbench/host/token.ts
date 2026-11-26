import { z } from 'zod';
import { sessionJson } from './session-fetch.ts';

/**
 * The Workbench token (design §2.3): minted per org from the session, pinned to Test, 15 minutes,
 * renewed at 12 while the tab is visible. It lives in this module's memory only: never storage, a
 * cookie, a URL, the DOM or anything shown.
 */
export const TOKEN_PATH = '/api/v1/workbench/token';
export const RENEW_MS = 12 * 60_000;

const MintSchema = z.object({
  token: z.string().min(1),
  orgId: z.string(),
  mode: z.literal('test'),
  expiresAt: z.number(),
  subject: z.enum(['sandbox_key', 'member']),
});

interface Held {
  value: string;
  renewAt: number;
}

const held = new Map<string, Held>();
const inflight = new Map<string, Promise<string>>();

/** When a held token is due: 12 minutes in, or 3 before its end if the server gave less. */
export function renewAt(now: number, expiresAt: number): number {
  return Math.min(now + RENEW_MS, expiresAt - 3 * 60_000);
}

async function mint(orgId: string, csrf: string): Promise<string> {
  const body = await sessionJson(TOKEN_PATH, MintSchema, {
    method: 'POST',
    body: { orgId },
    csrf,
  });
  // A token for another org, or not Test, is never used.
  if (body.orgId !== orgId) throw new Error('Workbench token for another organization.');
  held.set(orgId, { value: body.token, renewAt: renewAt(Date.now(), body.expiresAt) });
  return body.token;
}

/** The org's token, minted first when none is held or it is due. One mint at a time per org. */
export function workbenchToken(orgId: string, csrf: string): Promise<string> {
  const current = held.get(orgId);
  if (current && Date.now() < current.renewAt) return Promise.resolve(current.value);
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

/** The server refused the token: forget it, so the next call mints. */
export function dropToken(orgId: string): void {
  held.delete(orgId);
}

/** Sign-out and principal changes: no token outlives its session. */
export function forgetTokens(): void {
  held.clear();
  inflight.clear();
}
