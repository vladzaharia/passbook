import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrgMembership } from '@/shared/contracts/org-membership.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { setSessionPrincipalProvider } from './api.ts';
import { ApiError } from './errors.ts';
import { resetModeForTests, setMode } from './mode.ts';
import { createQueryClient, shouldRetry } from './query-client.ts';
import { membershipsQuery, sessionQuery } from './session.ts';

vi.mock('./api.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api.ts')>();
  return { ...real, setSessionPrincipalProvider: vi.fn(real.setSessionPrincipalProvider) };
});

describe('shouldRetry', () => {
  it('does not retry a response that failed its schema', () => {
    expect(shouldRetry(0, new ApiError({ status: 502, code: 'invalid_response' }))).toBe(false);
  });

  it('retries transient failures twice', () => {
    const error = new ApiError({ status: 503, code: 'unavailable' });
    expect(shouldRetry(0, error)).toBe(true);
    expect(shouldRetry(1, error)).toBe(true);
    expect(shouldRetry(2, error)).toBe(false);
  });

  it('does not retry client errors', () => {
    expect(shouldRetry(0, new ApiError({ status: 404, code: 'not_found' }))).toBe(false);
  });
});

describe('mode changes', () => {
  afterEach(resetModeForTests);

  it('keeps the session and current memberships while clearing mode-scoped data', async () => {
    resetModeForTests();
    const client = createQueryClient();
    const session = {
      authenticated: false,
      turnstileSiteKey: 'test',
      oidcEnabled: true,
      magicLinkEnabled: true,
    } as const;
    const memberships: { items: OrgMembership[] } = {
      items: [
        {
          id: 'm1',
          orgId: 'org-a',
          orgName: 'Organization A',
          orgSlug: 'org-a',
          userId: 'u1',
          roles: ['pass_operator'],
          capabilities: ['org:read', 'passes:read', 'passes:operate'],
          createdAt: 1,
          revokedAt: null,
        },
      ],
    };
    client.setQueryData(sessionQuery.queryKey, session);
    client.setQueryData(membershipsQuery.queryKey, memberships);
    client.setQueryData(['admin', 'passes'], { items: ['live-pass'] });
    client.setQueryData(['org-memberships', 'other'], { items: ['mode-dependent'] });

    setMode('test');

    await vi.waitFor(() => {
      expect(client.getQueryData(['admin', 'passes'])).toBeUndefined();
      expect(client.getQueryData(['org-memberships', 'other'])).toBeUndefined();
    });
    expect(client.getQueryData(sessionQuery.queryKey)).toEqual(session);
    expect(client.getQueryData(membershipsQuery.queryKey)).toEqual(memberships);
    client.clear();
  });
});

describe('session principal', () => {
  const signedIn = (id: string): SessionResponse => ({
    authenticated: true,
    user: { id, name: 'Test', primaryEmail: `${id}@example.com` },
    roles: ['user'],
    csrfToken: 'csrf',
    amr: 'oidc',
    expiresAt: 4_000_000_000_000,
  });

  it('changes only with the user, not with a failed or repeated session refresh', () => {
    const client = createQueryClient();
    const provider = vi.mocked(setSessionPrincipalProvider).mock.calls.at(-1)?.[0];
    if (!provider) throw new Error('Expected the principal provider to be wired.');
    client.setQueryData(sessionQuery.queryKey, signedIn('u1'));
    const first = provider();
    const cached = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    if (!cached) throw new Error('Expected a cached session');
    // A refresh that fails keeps the data; recovering must not look like a new account.
    cached.setState({ status: 'error', error: new Error('offline') });
    expect(provider()).toBe(first);
    cached.setState({ status: 'success', error: null });
    expect(provider()).toBe(first);
    client.setQueryData(sessionQuery.queryKey, signedIn('u1'));
    expect(provider()).toBe(first);
    client.setQueryData(sessionQuery.queryKey, signedIn('u2'));
    expect(provider()).not.toBe(first);
  });
});
