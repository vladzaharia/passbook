import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { type SessionResponse, SessionResponseSchema } from '@/shared/contracts/session.ts';
import { api } from './api.ts';

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

/** True if this tab signed out in the last two minutes: the sign-in scene waves goodbye. */
export function signedOutJustNow(now = Date.now()): boolean {
  try {
    const at = Number(sessionStorage.getItem(BYE));
    return at > 0 && now - at < 120_000;
  } catch {
    // Storage blocked: no wave.
    return false;
  }
}

/** Once read, the mark goes: the next sign-in page does not wave again. */
export function clearSignedOut(): void {
  try {
    sessionStorage.removeItem(BYE);
  } catch {
    // Storage blocked: nothing was stored.
  }
}

/** The server answers {ok, redirect}; the redirect may go through the IdP's end-session endpoint. */
export async function signOut(csrfToken?: string): Promise<void> {
  let target = '/login';
  try {
    const res = await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    });
    const body = (await res.json()) as { redirect?: unknown };
    if (typeof body.redirect === 'string' && body.redirect) target = body.redirect;
  } catch {
    // Network or parse failure: the cookie may still be set; /login re-checks the session.
  }
  try {
    sessionStorage.setItem(BYE, String(Date.now()));
  } catch {
    // Storage blocked: the sign-in page just skips the wave.
  }
  window.location.assign(target);
}
