import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
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
    window.matchMedia = ((query: string) => ({
      matches: false,
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
}

export async function renderApp(path: string, options: RenderAppOptions = {}) {
  const kind = options.session ?? 'user';
  const fetchMock = stubFetch({
    '/api/v1/session': () => json(sessionFixture(kind)),
    '/api/v1/orgs': () => json({ items: [], nextCursor: null }),
    ...options.handlers,
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ queryClient, history });
  const utils = render(
    <AppProviders queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, router, queryClient, fetchMock };
}
