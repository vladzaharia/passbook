import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { OrgCapabilitySchema, type OrgMembership } from '@/shared/contracts/org-membership.ts';
import type { SessionResponse } from '@/shared/contracts/session.ts';
import { createAppRouter } from '../router.tsx';
import { AppProviders } from './providers.tsx';
import { createQueryClient } from './query-client.ts';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** jsdom lacks APIs that Radix and cmdk call. Safe to run repeatedly. */
export function installDomShims(): void {
  globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => {};
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  if (!window.matchMedia) {
    // Tests run with reduced motion, like e2e: counts and transitions settle at once.
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
}

installDomShims();

export type SessionKind = 'admin' | 'user' | 'anon';

export function sessionFixture(kind: SessionKind): SessionResponse {
  if (kind === 'anon') {
    return {
      authenticated: false,
      turnstileSiteKey: '1x00000000000000000000AA',
      oidcEnabled: true,
      magicLinkEnabled: true,
    };
  }
  return {
    authenticated: true,
    user: { id: 'u1', name: 'Test User', primaryEmail: 'test@example.com' },
    roles: kind === 'admin' ? ['admin', 'user'] : ['user'],
    csrfToken: 'csrf-test',
    amr: 'oidc',
    expiresAt: 4_000_000_000_000,
  };
}

export function membershipFixture(
  orgId: string,
  overrides: Partial<OrgMembership> = {},
): OrgMembership {
  return {
    id: `membership-${orgId}`,
    orgId,
    orgName: orgId,
    orgSlug: orgId,
    userId: 'u1',
    roles: ['org_admin'],
    capabilities: [...OrgCapabilitySchema.options],
    createdAt: 1_700_000_000_000,
    revokedAt: null,
    ...overrides,
  };
}

export function problem(status: number, code: string, detail: string, issues?: unknown[]) {
  return new Response(
    JSON.stringify({ type: `about:blank#${code}`, title: code, status, code, detail, issues }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export type FetchHandler = (
  url: URL,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

/** Stubs global fetch. Unlisted paths answer 404 problem+json. */
export function stubFetch(handlers: Record<string, FetchHandler>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const handler = handlers[url.pathname];
    return handler ? handler(url, init) : problem(404, 'not_found', 'Not found.');
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

export interface RenderAppOptions {
  session?: SessionKind;
  handlers?: Record<string, FetchHandler>;
  memberships?: OrgMembership[];
  selectedOrg?: string;
}

export async function renderApp(path: string, options: RenderAppOptions = {}) {
  const kind = options.session ?? 'user';
  const fetchMock = stubFetch({
    '/api/v1/session': () => json(sessionFixture(kind)),
    '/api/v1/orgs/memberships/me': () => json({ items: options.memberships ?? [] }),
    '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
    ...options.handlers,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  const hashIndex = path.indexOf('#');
  const route = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : path.slice(hashIndex);
  const queryIndex = route.indexOf('?');
  const search = new URLSearchParams(queryIndex === -1 ? '' : route.slice(queryIndex + 1));
  const initialPath =
    options.selectedOrg !== undefined && !search.has('orgId')
      ? `${route}${queryIndex === -1 ? '?' : route.endsWith('?') || route.endsWith('&') ? '' : '&'}orgId=${encodeURIComponent(options.selectedOrg)}${hash}`
      : path;
  const history = createMemoryHistory({ initialEntries: [initialPath] });
  const router = createAppRouter({ queryClient, history });
  const utils = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, router, queryClient, fetchMock };
}
