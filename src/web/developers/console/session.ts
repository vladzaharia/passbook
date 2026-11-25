/**
 * Who is looking: signed out, signed in without a sandbox, or with one. Plain fetches, no React:
 * the answer decides whether the console chunk loads at all.
 */
import { hasDeveloperAccess, needsPocketId, type SignInMethod } from '../../../shared/spaces.ts';

export interface Sandbox {
  id: string;
  orgSlug: string;
  templateId: string | null;
}

export type Session =
  | { kind: 'out' }
  | { kind: 'none'; csrf: string; siteKey: string }
  /** `siteKey`: the check Start over runs. */
  | { kind: 'closed'; csrf: string; siteKey: string }
  /** The sandbox could not be read (a server error): not the same as having none. */
  | { kind: 'failed'; csrf: string }
  /** `siteKey`: the check that finishes a sandbox's setup again (the quickstart's repair). */
  | { kind: 'ready'; csrf: string; sandbox: Sandbox; siteKey: string };

/** Why a visitor counts as signed out: no session, an email link (holder only), or no developer group. */
export interface Gate {
  reason: 'none' | 'email' | 'noaccess';
  /** Who is signed in, for the no-access line. */
  email: string | null;
}

const API = '/api/v1';
let gate: Gate = { reason: 'none', email: null };
let pending: Promise<Session> | undefined;

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function read(): Promise<Session> {
  const head = { accept: 'application/json' };
  const me = await json(await fetch(`${API}/session`, { headers: head }));
  if (me.authenticated !== true || typeof me.csrfToken !== 'string') return { kind: 'out' };
  const user = me.user as { primaryEmail?: unknown } | undefined;
  const email = typeof user?.primaryEmail === 'string' ? user.primaryEmail : null;
  // An email link signs in to the holder's spaces only (shared/spaces.ts): here that is signed out.
  if (needsPocketId('developers', me.amr as SignInMethod)) {
    gate = { reason: 'email', email };
    return { kind: 'out' };
  }
  const roles = Array.isArray(me.roles) ? (me.roles as string[]) : [];
  if (!hasDeveloperAccess(roles)) {
    gate = { reason: 'noaccess', email };
    return { kind: 'out' };
  }
  const csrf = me.csrfToken;
  const res = await fetch(`${API}/developer/sandbox`, { headers: head });
  if (res.status === 401) return { kind: 'out' };
  const body = await json(res);
  const box = body.sandbox as Record<string, unknown> | null | undefined;
  if (!res.ok) return { kind: 'failed', csrf };
  if (!box)
    return {
      kind: 'none',
      csrf,
      siteKey: typeof body.turnstileSiteKey === 'string' ? body.turnstileSiteKey : '',
    };
  if (box.closedAt)
    return {
      kind: 'closed',
      csrf,
      siteKey: typeof body.turnstileSiteKey === 'string' ? body.turnstileSiteKey : '',
    };
  return {
    kind: 'ready',
    csrf,
    siteKey: typeof body.turnstileSiteKey === 'string' ? body.turnstileSiteKey : '',
    sandbox: {
      id: String(box.id),
      orgSlug: String(box.orgSlug),
      templateId: typeof box.templateId === 'string' ? box.templateId : null,
    },
  };
}

/** Read after `loadSession()` resolved to `out`. */
export const signedOutGate = (): Gate => gate;

const listeners = new Set<(s: Session) => void>();

/** Tells everything that read the session that it changed: the quickstart made the sandbox, so the org chip follows. */
export function updateSession(next: Session): void {
  pending = Promise.resolve(next);
  for (const fn of listeners) fn(next);
}

export function onSession(fn: (s: Session) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** One lookup per page, shared by the org chip, every Run slot and the sheet. */
export function loadSession(): Promise<Session> {
  pending ??= read().catch(() => ({ kind: 'out' }) as Session);
  return pending;
}
