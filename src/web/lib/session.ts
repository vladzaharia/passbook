import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SessionResponse, SessionResponseSchema } from '@/shared/contracts/session.ts';
import { safeNextPath } from '@/shared/next.ts';
import { api } from './api.ts';
import { problemToError } from './errors.ts';
import { loginHref } from './redirect.ts';

export type AuthedSession = Extract<SessionResponse, { authenticated: true }>;

export const sessionQuery = queryOptions({
  queryKey: ['session'] as const,
  queryFn: ({ signal }) => api.get('/api/v1/session', SessionResponseSchema, { signal }),
  staleTime: 60_000,
});

export function isAdmin(session: SessionResponse | undefined): session is AuthedSession {
  return session?.authenticated === true && session.roles.includes('admin');
}

export function useSession() {
  const query = useQuery(sessionQuery);
  const session = query.data;
  return {
    ...query,
    session,
    authed: session?.authenticated === true ? session : undefined,
    isAdmin: isAdmin(session),
  };
}

export function useInvalidateSession(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: sessionQuery.queryKey });
}

const BYE = 'wallet-signed-out';
const BYE_NEXT = 'wallet-signed-out-next';
const BYE_MS = 120_000;

/** True if this tab signed out in the last two minutes: the sign-in scene waves goodbye. */
export function signedOutJustNow(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(BYE));
    return at > 0 && now - at < BYE_MS;
  } catch {
    // Storage blocked: no wave.
    return false;
  }
}

/**
 * The next a sign-out-to-switch asked for. Pocket ID's end-session returns to a bare /login, so
 * this tab keeps it for two minutes.
 */
export function signedOutNext(now = Date.now()): string | null {
  if (!signedOutJustNow(now)) return null;
  try {
    return safeNextPath(sessionStorage.getItem(BYE_NEXT));
  } catch {
    // Storage blocked: sign-in falls back to the landing rule.
    return null;
  }
}

/** Once read, the marks go: the next sign-in page does not wave again. */
export function clearSignedOut(): void {
  try {
    sessionStorage.removeItem(BYE);
    sessionStorage.removeItem(BYE_NEXT);
  } catch {
    // Storage blocked: nothing was stored.
  }
}

export interface SignOutOptions {
  /** Where to land after signing in again. */
  next?: string | undefined;
  /** End every session of this account; throws if the server refuses. */
  everywhere?: boolean;
}

/**
 * POST /auth/logout. Resolves to where the browser goes next: the sign-in page (keeping next)
 * or the IdP's end-session endpoint.
 */
export async function endSession(
  csrfToken: string | undefined,
  { next, everywhere = false }: SignOutOptions = {},
): Promise<string> {
  const safe = safeNextPath(next);
  const query = new URLSearchParams();
  if (everywhere) query.set('all', '1');
  if (safe) query.set('next', safe);
  let target = safe ? loginHref(safe) : '/login';
  try {
    const res = await fetch(`/auth/logout${query.size ? `?${query}` : ''}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    });
    const body = (await res.json()) as { redirect?: unknown };
    if (!res.ok) throw problemToError(res.status, body);
    if (typeof body.redirect === 'string' && body.redirect) target = body.redirect;
  } catch (error) {
    // Ending other sessions must not fail silently; one sign-out still leaves, and /login
    // re-checks the session.
    if (everywhere) throw error;
  }
  return target;
}

/** Leaves for `target`, marking the tab so the sign-in page waves and keeps `next`. */
export function leaveSignedOut(target: string, next?: string): void {
  try {
    sessionStorage.setItem(BYE, String(Date.now()));
    const safe = safeNextPath(next);
    if (safe) sessionStorage.setItem(BYE_NEXT, safe);
    else sessionStorage.removeItem(BYE_NEXT);
  } catch {
    // Storage blocked: the sign-in page just skips the wave.
  }
  window.location.assign(target);
}

export async function signOut(csrfToken?: string, options: SignOutOptions = {}): Promise<void> {
  leaveSignedOut(await endSession(csrfToken, options), options.next);
}
