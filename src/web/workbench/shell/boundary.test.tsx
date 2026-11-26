import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { WB_TOOLS } from '@/shared/workbench.ts';
import { json, renderApp } from '../../lib/test-utils.tsx';
import { fixtureOperation, NOW, SANDBOX_CREATE } from '../../ui/operation/fixtures.test-support.ts';
import { resetOperationCache } from '../../ui/operation/store.ts';
import type { Operation } from '../../ui/operation/types.ts';
import { forgetTokens } from '../host/token.ts';
import { setSingleKeys } from './prefs.ts';
import { CONTEXTS, handlers } from './test-fixtures.ts';

afterEach(() => {
  forgetTokens();
  resetOperationCache();
  setSingleKeys(true);
  localStorage.clear();
  sessionStorage.clear();
});

const running = (id: string, text: string, orgId: string, mode: 'test' | 'live'): Operation => ({
  ...fixtureOperation(SANDBOX_CREATE, { status: 'running', id }),
  text,
  orgId,
  mode,
  updatedAt: NOW,
});

/**
 * Account-level reads ride the session: who is signed in, the contexts, the token mint, and the
 * account menu's own membership lists. Every other /api call is a tenant call.
 */
const SESSION_PATHS = new Set([
  '/api/v1/session',
  '/api/v1/workbench/contexts',
  '/api/v1/workbench/token',
  '/api/v1/orgs/memberships/me',
  '/api/v1/orgs',
]);
/**
 * W2 moved these sandbox-only tools in with their calls still on the cookie session. The server holds a
 * sandbox to Test (`SANDBOX_TEST_ONLY`). Each entry names the T package that moves it onto the token;
 * the list shrinks to zero and the test below fails if it grows.
 */
const SESSION_CLIENT_EXEMPT: readonly { path: string; movedBy: string }[] = [
  { path: '/api/v1/developer/sandbox', movedBy: 'T1' },
  { path: '/api/v1/developer/home', movedBy: 'T8' },
];
const EXEMPT_PATHS = new Set(SESSION_CLIENT_EXEMPT.map((e) => e.path));
const allCalls = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls
    .map(([url, init]) => ({
      path: new URL(String(url), 'http://localhost').pathname,
      init: (init ?? {}) as RequestInit,
    }))
    .filter(({ path }) => path.startsWith('/api/'));
const apiCalls = (fetchMock: { mock: { calls: unknown[][] } }) =>
  allCalls(fetchMock).filter(({ path }) => !SESSION_PATHS.has(path) && !EXEMPT_PATHS.has(path));

const headerOf = (init: RequestInit): Record<string, string> =>
  Object.fromEntries(new Headers(init.headers).entries());

describe('the Workbench tray (R4 H1)', () => {
  const ops = [
    running('op_live', 'LIVE bulk reissue', 'nw', 'live'),
    running('op_other', 'OTHER org test job', 'ac', 'test'),
    running('op_mine', 'NW test job', 'nw', 'test'),
  ];
  const withOps = () => ({
    ...handlers(),
    '/api/v1/operations': () => json({ items: ops }),
  });

  it("lists only this context's Test operations, and counts only those", async () => {
    const { fetchMock } = await renderApp('/workbench/o/nw/activity', {
      session: 'developer',
      handlers: withOps(),
    });
    const tray = await screen.findByRole('button', { name: 'Activity, 1 running' });
    expect(
      await within(screen.getByRole('navigation', { name: 'Workbench' })).findByRole('link', {
        name: 'Activity, 1 running',
      }),
    ).toBeInTheDocument();
    fireEvent.click(tray);
    expect(await screen.findByText(/NW test job/)).toBeInTheDocument();
    expect(screen.queryByText(/LIVE bulk reissue/)).not.toBeInTheDocument();
    expect(screen.queryByText(/OTHER org test job/)).not.toBeInTheDocument();
    // It polled with the token, not the session alone.
    const polled = apiCalls(fetchMock).filter(({ path }) => path === '/api/v1/operations');
    expect(polled.length).toBeGreaterThan(0);
    for (const { init } of polled) {
      expect(headerOf(init).authorization).toBe('Bearer pbtry_nw');
      expect(Object.keys(headerOf(init)).some((h) => /mode/i.test(h))).toBe(false);
    }
  });

  it('draws no tray where there is no context', async () => {
    const two = {
      sandbox: null,
      orgs: [
        { orgId: 'nw', name: 'Northwind', slug: 'nw', tools: ['logs'] },
        { orgId: 'ac', name: 'Acme', slug: 'ac', tools: ['logs'] },
      ],
    };
    const { fetchMock } = await renderApp('/workbench', {
      session: 'user',
      handlers: { ...handlers({}, two), '/api/v1/operations': () => json({ items: ops }) },
    });
    await screen.findByRole('heading', { name: 'Choose a context', level: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('button', { name: /^Activity/ })).not.toBeInTheDocument();
    expect(apiCalls(fetchMock).filter(({ path }) => path === '/api/v1/operations')).toEqual([]);
  });
});

describe('the session-client exemption list', () => {
  it('only shrinks: at most two sandbox-only entries, each owned by a T package', () => {
    expect(SESSION_CLIENT_EXEMPT.length).toBeLessThanOrEqual(2);
    for (const { path, movedBy } of SESSION_CLIENT_EXEMPT) {
      expect(path).toMatch(/^\/api\/v1\/developer\/(sandbox|home)$/);
      expect(movedBy).toMatch(/^T[1-8]$/);
    }
  });
});

describe('the runtime boundary (R4 M7, L14)', () => {
  it.each(WB_TOOLS.filter((t) => t !== 'sandbox' && t !== 'quickstart'))(
    '%s: every tenant call carries the token, none a mode header',
    async (tool) => {
      const path = tool === 'home' ? '/workbench/o/nw' : `/workbench/o/nw/${tool}`;
      const { fetchMock } = await renderApp(path, {
        session: 'developer',
        handlers: {
          ...handlers({ errors: 2 }),
          // The Console reads the docs' operation index (a static file, not an API call).
          '/developers/run/index.json': () => json({ codes: [], groups: [] }),
          '/api/v1/operations': () =>
            json({ items: [running('op_1', 'NW test job', 'nw', 'test')] }),
        },
      });
      await screen.findByRole('button', { name: 'Activity, 1 running' });
      await waitFor(() =>
        expect(apiCalls(fetchMock).some(({ path: p }) => p === '/api/v1/workbench/summary')).toBe(
          true,
        ),
      );
      // No call at all, the session's own included, names a mode: the Workbench is Test by its token.
      for (const { path: p, init } of allCalls(fetchMock))
        expect(
          Object.keys(headerOf(init)).filter((h) => /mode/i.test(h)),
          p,
        ).toEqual([]);
      const calls = apiCalls(fetchMock);
      expect(calls.length).toBeGreaterThan(1);
      for (const { path: p, init } of calls) {
        const headers = headerOf(init);
        expect(headers.authorization, p).toBe('Bearer pbtry_nw');
        expect(
          Object.keys(headers).filter((h) => /mode|csrf/i.test(h)),
          p,
        ).toEqual([]);
      }
    },
  );

  it('the sandbox context holds to the same rule', async () => {
    const { fetchMock } = await renderApp('/workbench/o/sbx/sandbox', {
      session: 'developer',
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'Sandbox', level: 1 });
    await waitFor(() => expect(apiCalls(fetchMock).length).toBeGreaterThan(0));
    for (const { path: p, init } of apiCalls(fetchMock))
      expect(headerOf(init).authorization, p).toBe(`Bearer pbtry_${CONTEXTS.sandbox.orgId}`);
  });
});

describe('more of the boundary (R4 N3)', () => {
  it('Quickstart in the sandbox: every tenant call carries the token', async () => {
    const { fetchMock } = await renderApp('/workbench/quickstart', {
      session: 'developer',
      handlers: handlers(),
    });
    await waitFor(() => expect(screen.getByRole('main')).toHaveTextContent('Quickstart'));
    await waitFor(() => expect(apiCalls(fetchMock).length).toBeGreaterThan(0));
    for (const { path: p, init } of allCalls(fetchMock)) {
      expect(
        Object.keys(headerOf(init)).filter((h) => /mode/i.test(h)),
        p,
      ).toEqual([]);
      if (!SESSION_PATHS.has(p) && !EXEMPT_PATHS.has(p))
        expect(headerOf(init).authorization, p).toBe('Bearer pbtry_sbx');
    }
  });

  it('signed-out Design makes no call but the session read', async () => {
    const { fetchMock } = await renderApp('/workbench/design', {
      session: 'anon',
      handlers: handlers(),
    });
    await screen.findByRole('heading', { name: 'Design', level: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(allCalls(fetchMock).map(({ path: p }) => p)).toEqual(['/api/v1/session']);
  });

  it("the tray's Retry and Cancel go through the token", async () => {
    const failed = {
      ...running('op_failed', 'NW failed job', 'nw', 'test'),
      status: 'failed' as const,
      cancelable: false,
      error: { code: 'internal', message: 'It broke.', retryable: true },
      finishedAt: Date.now(),
      updatedAt: Date.now(),
    } as Operation;
    const live = running('op_run', 'NW running job', 'nw', 'test');
    const posts: string[] = [];
    const post = (id: string) => (_u: URL, init?: RequestInit) => {
      posts.push(`${id}:${String(init?.method)}`);
      return json({ operation: { ...live, id } });
    };
    const { fetchMock } = await renderApp('/workbench/o/nw/activity', {
      session: 'developer',
      handlers: {
        ...handlers(),
        '/api/v1/operations': () => json({ items: [live, failed] }),
        '/api/v1/operations/op_run': () => json(live),
        '/api/v1/operations/op_failed': () => json(failed),
        '/api/v1/operations/op_run/cancel': post('op_run'),
        '/api/v1/operations/op_failed/retry': post('op_failed'),
      },
    });
    const tray = await screen.findByRole('button', { name: /^Activity, 1 running/ });
    await userEvent.click(tray);
    await userEvent.click(await screen.findByText(/NW running job/));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(posts).toContain('op_run:POST'));
    await userEvent.keyboard('{Escape}');
    await userEvent.click(await screen.findByRole('button', { name: /^Activity, / }));
    await waitFor(() =>
      expect(document.querySelector('[data-radix-popper-content-wrapper]')).not.toBeNull(),
    );
    const popover = document.querySelector('[data-radix-popper-content-wrapper]') as HTMLElement;
    await userEvent.click((await within(popover).findAllByText(/NW failed job/))[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(posts).toContain('op_failed:POST'));
    for (const { path: p, init } of apiCalls(fetchMock).filter(
      ({ init: i }) => i.method === 'POST',
    )) {
      expect(headerOf(init).authorization, p).toBe('Bearer pbtry_nw');
      expect(
        Object.keys(headerOf(init)).some((h) => /mode|csrf/i.test(h)),
        p,
      ).toBe(false);
    }
  });
});
