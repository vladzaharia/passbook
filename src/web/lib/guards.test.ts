import { QueryClient } from '@tanstack/react-query';
import { isRedirect } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.ts';
import { isAdminPath, isPublicPath, requireAdmin, requireSession } from './guards.ts';
import { sessionQuery } from './session.ts';
import { type SessionKind, sessionFixture } from './test-utils.tsx';

function clientWith(kind: SessionKind) {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, sessionFixture(kind));
  return client;
}

describe('requireSession', () => {
  it('returns the session when signed in', async () => {
    const session = await requireSession(clientWith('user'), '/account');
    expect(session.user.id).toBe('u1');
  });

  it('redirects to /login with next when signed out', async () => {
    const error = await requireSession(clientWith('anon'), '/passes/1?x=2').catch(
      (e: unknown) => e,
    );
    expect(isRedirect(error)).toBe(true);
    expect((error as { options: { to: string; search: unknown } }).options).toMatchObject({
      to: '/login',
      search: { next: '/passes/1?x=2' },
    });
  });

  it('drops an off-site next and home, so signing in picks the landing', async () => {
    for (const next of ['//evil.com', '/']) {
      const error = await requireSession(clientWith('anon'), next).catch((e: unknown) => e);
      expect((error as { options: { search: unknown } }).options.search).toEqual({});
    }
  });
});

describe('requireAdmin', () => {
  it('passes admins', async () => {
    await expect(requireAdmin(clientWith('admin'), '/admin')).resolves.toBeTruthy();
  });

  it('throws a 403 ApiError for signed-in non-admins', async () => {
    const error = await requireAdmin(clientWith('user'), '/admin').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('redirects signed-out users before checking roles', async () => {
    const error = await requireAdmin(clientWith('anon'), '/admin').catch((e: unknown) => e);
    expect(isRedirect(error)).toBe(true);
  });
});

describe('path helpers', () => {
  it('recognises admin and public paths exactly', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/passes')).toBe(true);
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/login/x')).toBe(false);
  });
});
