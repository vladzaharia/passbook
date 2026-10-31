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

/** The server answers with a redirect; the SPA ignores it and goes to /login. */
export async function signOut(csrfToken?: string): Promise<void> {
  await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'manual',
    headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
  });
  window.location.assign('/login');
}
