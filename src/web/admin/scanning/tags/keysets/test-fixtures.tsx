import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import type { Keyset } from './api.ts';

export const NOW = 1_800_000_000_000;
export const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
export const reader = membershipFixture('o1', {
  orgName: 'Northwind',
  orgSlug: 'northwind',
  roles: ['pass_operator'],
  capabilities: ['scanning:read', 'passes:operate'],
});

export function keysetFixture(over: Partial<Keyset> = {}): Keyset {
  return {
    id: 'k1',
    name: 'Staff badges',
    slug: 'abcd1234',
    diversify: true,
    perTag: false,
    createdAt: NOW - 86_400_000,
    disabledAt: null,
    versions: [
      {
        version: 1,
        state: 'retiring',
        createdAt: NOW - 86_400_000,
        stateAt: NOW - 3_600_000,
        revokedAt: null,
        tags: 2,
      },
      {
        version: 2,
        state: 'active',
        createdAt: NOW - 3_600_000,
        stateAt: null,
        revokedAt: null,
        tags: 5,
      },
    ],
    ...over,
  };
}
export const supplierFixture = (over: Partial<Keyset> = {}) =>
  keysetFixture({
    id: 'k2',
    name: 'Supplier tags',
    slug: 'wxyz5678',
    diversify: false,
    perTag: true,
    versions: [
      { version: 1, state: 'active', createdAt: NOW, stateAt: null, revokedAt: null, tags: 0 },
    ],
    ...over,
  });

export const KEY = '00112233445566778899aabbccddeeff';
const empty = () => json({ items: [], nextCursor: null });

/** The Tags tab on its Secure keys view; `keysets` answer the list. */
export function openKeys(
  keysets: Keyset[],
  extra: Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>> = {},
  query = '',
  membership = northwind,
) {
  return renderApp(`/admin/scanning?tab=tags&tagView=keys${query}`, {
    session: 'admin',
    memberships: [membership],
    selectedOrg: 'o1',
    handlers: {
      '/api/v1/scanning-sessions': empty,
      '/api/v1/scan-setups': empty,
      '/api/v1/nfc/keysets': (_url, init) =>
        init?.method === 'POST' ? json({}, 201) : json({ items: keysets, nextCursor: null }),
      ...extra,
    },
  });
}

export const posted = (m: { mock: { calls: unknown[][] } }, suffix: string) =>
  m.mock.calls.filter(
    ([u, init]) =>
      String(u).split('?')[0]?.endsWith(suffix) &&
      (init as RequestInit | undefined)?.method === 'POST',
  );
export const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? 'null'));
