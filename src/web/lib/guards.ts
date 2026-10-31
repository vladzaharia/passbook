import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { safeNext } from './redirect.ts';
import { ApiError } from './errors.ts';
import { type AuthedSession, isAdmin, sessionQuery } from './session.ts';

export const ADMIN_PREFIX = '/admin';

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
}

/** Routes the session guard skips: the sign-in page itself. */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/login';
}

export async function requireSession(
  queryClient: QueryClient,
  next: string,
): Promise<AuthedSession> {
  const session = await queryClient.ensureQueryData(sessionQuery);
  if (!session.authenticated) {
    throw redirect({ to: '/login', search: { next: safeNext(next) } });
  }
  return session;
}

export async function requireAdmin(queryClient: QueryClient, next: string): Promise<AuthedSession> {
  const session = await requireSession(queryClient, next);
  if (!isAdmin(session)) {
    throw new ApiError({ status: 403, code: 'forbidden', detail: 'Admin access required.' });
  }
  return session;
}
