import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture } from '@/web/lib/test-utils.tsx';

export const email = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  orgId: 'o1',
  kind: 'pass',
  passId: 'p1',
  bundleId: null,
  to: 'holder@example.com',
  subject: 'Your Gym pass',
  attached: false,
  createdAt: Date.now() - 3_600_000,
  ...over,
});

export const detail = (forwarding = 'none') => ({
  ...email(),
  html: '<p>Hi</p>',
  text: 'Hi there from the pass email.',
  forwarding,
});

export function deferredResponse() {
  const deferred = Promise as PromiseConstructor & {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T) => void;
      reject: (reason: unknown) => void;
    };
  };
  return deferred.withResolvers<Response>();
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

export function setupInboxTest() {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => {
    resetModeForTests();
    vi.unstubAllGlobals();
  });
}

export const verifiedEmails = {
  items: [{ email: 'admin@example.com', verifiedAt: 1, verifiedVia: 'oidc', primary: false }],
};
export const handlers = {
  '/api/v1/test-inbox': () => json({ items: [email()], nextCursor: null }),
  '/api/v1/test-inbox/e1': () => json(detail()),
  '/api/v1/me/emails': () => json(verifiedEmails),
};
export const orgAccess = { memberships: [membershipFixture('o1')], selectedOrg: 'o1' };
export const reader = membershipFixture('o1', {
  roles: ['read_only'],
  capabilities: ['org:read', 'passes:read'],
});
export const operator = membershipFixture('o1', {
  roles: ['pass_operator'],
  capabilities: ['org:read', 'passes:read', 'passes:operate'],
});
export const harbor = membershipFixture('o2', {
  orgName: 'Harbor',
  roles: ['pass_operator'],
  capabilities: ['org:read', 'passes:read', 'passes:operate'],
});

export async function enabledSendButton() {
  const button = await screen.findByRole('button', { name: 'Send to me' });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

export function sendRequests(fetchMock: { mock: { calls: [RequestInfo | URL, RequestInit?][] } }) {
  return fetchMock.mock.calls.filter(([url]) =>
    new URL(String(url), 'http://localhost').pathname.endsWith('/send-to-me'),
  );
}
