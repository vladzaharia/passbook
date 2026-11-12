import { notifyManager, queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { OrgMembershipListSchema } from '@/shared/contracts/org-membership.ts';
import { type SessionResponse, SessionResponseSchema } from '@/shared/contracts/session.ts';
import { NEXT_COOKIE, NEXT_COOKIE_PATH, safeNextPath } from '@/shared/next.ts';
import { api, resetSessionEnded } from './api.ts';
import { ApiError, problemToError } from './errors.ts';
import { clearLocalDrafts } from './local-drafts.ts';
import { clearPreviewBatches } from './preview-batch.ts';
import { loginHref } from './redirect.ts';

export type AuthedSession = Extract<SessionResponse, { authenticated: true }>;

const MEMBERSHIPS_QUERY_KEY = ['org-memberships', 'me'] as const;

function sessionChangedError(): ApiError {
  return new ApiError({
    status: 409,
    code: 'session_changed',
    detail: 'The signed-in account changed. Refresh the page and try again.',
  });
}

export const sessionQuery = queryOptions({
  queryKey: ['session'] as const,
  queryFn: async ({ client, signal }) => {
    const session = await api.get('/api/v1/session', SessionResponseSchema, { signal });
    signal.throwIfAborted();
    const previous = client.getQueryData<SessionResponse>(['session']);
    if (previous !== undefined) {
      const principalChanged =
        previous.authenticated !== session.authenticated ||
        (previous.authenticated && session.authenticated && previous.user.id !== session.user.id);
      if (principalChanged) {
        notifyManager.batch(() => {
          // Publish the new identity before cancelling old requests, so their late 401s cannot
          // end the new session. Observers see the identity and cache eviction in one batch.
          client.setQueryData<SessionResponse>(['session'], session);
          clearPreviewBatches();
          const cache = client.getQueryCache();
          for (const query of cache.getAll()) {
            if (query.queryKey.length === 1 && query.queryKey[0] === 'session') continue;
            void query.cancel({ silent: true });
            // Resetting instead would restore initialData belonging to the old principal.
            query.setState({
              data: undefined,
              dataUpdatedAt: 0,
              error: null,
              status: 'pending',
              fetchStatus: 'idle',
            });
            cache.remove(query);
          }
          // Pending requests retain their own guards; cache entries must not expose their input.
          client.getMutationCache().clear();
          if (session.authenticated) resetSessionEnded();
        });
      } else {
        void client.invalidateQueries({ queryKey: MEMBERSHIPS_QUERY_KEY, exact: true });
      }
    }
    return session;
  },
  staleTime: 60_000,
});

/** The signed-in principal's organization grants, never inferred from platform roles. */
export const MEMBERSHIPS_STALE_MS = 60_000;

export const membershipsQuery = queryOptions({
  queryKey: MEMBERSHIPS_QUERY_KEY,
  queryFn: async ({ client, signal }) => {
    const session = await client.ensureQueryData(sessionQuery);
    signal.throwIfAborted();
    if (!session.authenticated) {
      throw new ApiError({ status: 401, code: 'unauthenticated', detail: 'Sign in.' });
    }
    // A failed refresh keeps the last session; only a different user invalidates the request.
    const same = () => {
      const current = client.getQueryData<SessionResponse>(sessionQuery.queryKey);
      return current?.authenticated === true && current.user.id === session.user.id;
    };
    if (!same()) throw sessionChangedError();
    const memberships = await api.get('/api/v1/orgs/memberships/me', OrgMembershipListSchema, {
      signal,
    });
    signal.throwIfAborted();
    if (!same() || memberships.items.some((membership) => membership.userId !== session.user.id)) {
      throw sessionChangedError();
    }
    return memberships;
  },
  staleTime: MEMBERSHIPS_STALE_MS,
});

export function useMemberships() {
  return useQuery(membershipsQuery);
}

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
  return async () => {
    // Mark grants stale before refreshing the session, without unmounting scoped drafts.
    await client.invalidateQueries({
      queryKey: membershipsQuery.queryKey,
      exact: true,
      refetchType: 'none',
    });
    await client.invalidateQueries({ queryKey: sessionQuery.queryKey });
    // If the session was inactive, refresh active membership observers here. Otherwise join the
    // refetch started by sessionQuery rather than cancelling or duplicating it.
    await client.refetchQueries(
      { queryKey: membershipsQuery.queryKey, exact: true, type: 'active', stale: true },
      { cancelRefetch: false },
    );
  };
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

/** The next the logout POST left for a switch through Pocket ID (shared/next.ts). */
function cookieNext(): string | null {
  const raw = new RegExp(`(?:^|;\\s*)${NEXT_COOKIE}=([^;]*)`).exec(document.cookie)?.[1];
  if (!raw) return null;
  try {
    return safeNextPath(decodeURIComponent(raw));
  } catch {
    // Malformed escape: not a path the server wrote.
    return null;
  }
}

/**
 * The next a sign-out-to-switch asked for. Pocket ID's end-session returns to a bare /login, so
 * the server left it in a cookie, and this tab kept it for two minutes.
 */
export function signedOutNext(now = Date.now()): string | null {
  const kept = cookieNext();
  if (kept) return kept;
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
  if (document.cookie.includes(`${NEXT_COOKIE}=`)) {
    // biome-ignore lint/suspicious/noDocumentCookie: drops the single-use cookie the server set
    document.cookie = `${NEXT_COOKIE}=; Path=${NEXT_COOKIE_PATH}; Max-Age=0; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  }
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
  clearPreviewBatches();
  clearLocalDrafts();
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
