import { act, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';
import type { WorkbenchApi } from '../host/api.ts';
import { forgetTokens } from '../host/token.ts';
import { setSingleKeys } from '../shell/prefs.ts';
import { CONTEXTS, handlers } from '../shell/test-fixtures.ts';
import { useFresh, useRecentEvents } from './data.ts';
import { forgetMilestones, type Signals, useMilestone } from './milestones.ts';

afterEach(() => {
  forgetTokens();
  forgetMilestones();
  setSingleKeys(true);
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
});

const NOW = 1_700_000_000_000;
const call = (id: string, status: number) => ({
  id,
  requestId: `req-${id}`,
  at: NOW - 1000,
  method: 'POST',
  route: '/api/v1/passes',
  path: '/api/v1/passes',
  query: null,
  status,
  code: null,
  durationMs: 42,
  keyId: null,
  mode: 'test',
  via: null,
  client: 'curl',
  hasBodies: false,
  resourceId: null,
  apiVersion: null,
  flags: { idempotencyKey: false, ifMatch: false, version: false },
});
const event = (id: string) => ({
  id,
  type: 'pass.issued',
  apiVersion: '2026-11-20',
  createdAt: NOW - 500,
  orgId: 'sbx',
  mode: 'test',
  pass: { id: 'p1', externalId: null, templateId: 't1' },
  data: {},
});
const pass = (id: string) => ({
  id,
  orgId: 'sbx',
  templateId: 't1',
  templateVersion: '1',
  identityId: 'i1',
  serial: `S-${id}`,
  title: 'Gym pass',
  subtitle: null,
  externalId: null,
  status: 'active',
  mode: 'test',
  version: 2,
  connectionId: null,
  syncErrorCode: null,
  holderEmail: null,
  holderState: 'unassigned',
  ownerUserId: null,
  deviceCount: 0,
  removedAt: null,
  modifiedAt: NOW,
  createdAt: NOW,
});
const CURSOR = 'ev2.AAAAAAAAAAAAAAAAAAAAAA';

const homeHandlers = (
  summary: Record<string, unknown>,
  calls = [call('c1', 201)],
  timeZone?: string,
) => ({
  ...handlers({ quotas: null, ...summary }, timeZone ? withZone(timeZone) : undefined),
  '/api/v1/request-logs': () =>
    json({ items: calls, nextCursor: null, capped: null, bodiesRecorded: true }),
  '/api/v1/events': () => json({ items: [event('e1')], nextCursor: CURSOR, hasMore: false }),
  '/api/v1/passes': () => json({ items: [pass('p1')], nextCursor: null }),
  '/api/v1/passes/p1': () => json({ publicUrl: 'https://wallet.example/t/abc' }),
});

const withZone = (timeZone: string) => ({
  sandbox: { ...CONTEXTS.sandbox, timeZone },
  orgs: CONTEXTS.orgs,
});

const SANDBOX = {
  quickstart: { done: 3, total: 5 },
  quotas: {
    passes: { used: 2, limit: 25 },
    templates: { used: 1, limit: 3 },
    endpoints: { used: 1, limit: 2 },
    keys: { used: 1, limit: 3 },
  },
};

describe('Home (sandbox)', () => {
  it('shows the next step, the quota stats, recent calls and events, on the token', async () => {
    const { fetchMock } = await renderApp('/workbench/o/sbx', {
      session: 'developer',
      handlers: homeHandlers(SANDBOX),
    });
    expect(await screen.findByRole('heading', { name: 'Change the pass', level: 2 })).toBeVisible();
    expect(screen.getByRole('list', { name: '3 of 5 done' })).toBeInTheDocument();
    const calls = screen.getByRole('heading', { name: 'Recent calls' }).closest('div')
      ?.parentElement as HTMLElement;
    expect(await within(calls).findByRole('link', { name: /POST/ })).toHaveAttribute(
      'href',
      '/workbench/o/sbx/logs#req-c1',
    );
    const events = screen.getByRole('heading', { name: 'Recent events' }).closest('div')
      ?.parentElement as HTMLElement;
    expect(await within(events).findByRole('link', { name: /pass\.issued/ })).toHaveAttribute(
      'href',
      '/workbench/o/sbx/events#e1',
    );
    expect(await screen.findByRole('link', { name: /Passes\s*2\s*of 25/ })).toHaveAttribute(
      'href',
      '/workbench/o/sbx/passes',
    );
    expect(await screen.findByRole('link', { name: /Gym pass/ })).toHaveAttribute(
      'href',
      '/workbench/o/sbx/passes#p1',
    );
    expect(screen.queryByText('Test data only')).not.toBeInTheDocument();
    for (const [url, init] of fetchMock.mock.calls) {
      const path = new URL(String(url), 'http://localhost').pathname;
      if (!path.startsWith('/api/v1/') || path === '/api/v1/session') continue;
      if (path === '/api/v1/workbench/contexts' || path === '/api/v1/workbench/token') continue;
      if (path === '/api/v1/orgs' || path === '/api/v1/orgs/memberships/me') continue;
      expect(path).not.toMatch(/\/developer\//);
      expect(new Headers((init as RequestInit).headers).get('authorization')).toBe(
        'Bearer pbtry_sbx',
      );
    }
  });

  it('names what to try next once Quickstart is done, without the progress ticks', async () => {
    await renderApp('/workbench/o/sbx', {
      session: 'developer',
      handlers: homeHandlers({ ...SANDBOX, quickstart: { done: 5, total: 5 } }),
    });
    await screen.findByRole('heading', { name: 'Test passes' });
    expect(screen.getByText('Next step')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Hear a webhook' })).toBeInTheDocument();
    expect(screen.queryByText(/of 5 done/)).not.toBeInTheDocument();
  });

  it("asks the log to leave out the Workbench's own reads", async () => {
    const { fetchMock } = await renderApp('/workbench/o/sbx', {
      session: 'developer',
      handlers: homeHandlers(SANDBOX, [call('c1', 201)]),
    });
    expect(await screen.findByText('/passes')).toBeInTheDocument();
    const read = fetchMock.mock.calls.find(
      ([url]) => new URL(String(url), 'http://localhost').pathname === '/api/v1/request-logs',
    );
    expect(new URL(String(read?.[0]), 'http://localhost').searchParams.get('portal')).toBe('hide');
    // Its own reads carry the mark the log filters on.
    expect(new Headers(((read?.[1] ?? {}) as RequestInit).headers).get('x-passbook-client')).toBe(
      'portal',
    );
  });
});

describe('Home (org)', () => {
  it('says Test data only once and shows what needs a look', async () => {
    await renderApp('/workbench/o/nw', {
      session: 'developer',
      handlers: homeHandlers({ errors: 3, failedDeliveries: 0 }),
    });
    expect(await screen.findByText('Test data only')).toBeVisible();
    expect(screen.getAllByText('Test data only')).toHaveLength(1);
    expect(screen.getByText('Next step')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Errors\s*3/ })).toHaveAttribute(
      'href',
      '/workbench/o/nw/logs?status=4xx',
    );
  });
});

describe('useFresh', () => {
  it('washes only rows that arrive after the first read, then lets them go', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ ids, ready }) => useFresh(ids, ready), {
      initialProps: { ids: ['a', 'b'] as string[] | undefined, ready: true },
    });
    expect([...result.current]).toEqual([]);
    rerender({ ids: ['c', 'a', 'b'], ready: true });
    expect([...result.current]).toEqual(['c']);
    act(() => {
      vi.advanceTimersByTime(1_800);
    });
    expect([...result.current]).toEqual([]);
  });
});

describe('useMilestone', () => {
  const run = (initial: Signals) =>
    renderHook(({ s }) => useMilestone('sbx', s, true), { initialProps: { s: initial } });

  it('fires when a signal turns true, once, and never for what was already true', () => {
    const first = run({ firstCall: true, webhook: false });
    expect(first.result.current).toBeNull();
    first.rerender({ s: { firstCall: true, webhook: true } });
    expect(first.result.current).toBe('webhook');
    first.unmount();
    // A later visit: both are recorded, so neither fires again.
    const again = run({ firstCall: false, webhook: false });
    again.rerender({ s: { firstCall: true, webhook: true } });
    expect(again.result.current).toBeNull();
  });
});

describe('useRecentEvents', () => {
  it('reads one newest-first page, then asks only after its newest cursor', async () => {
    vi.useFakeTimers();
    const pages = [
      { items: [event('e9'), event('e8'), event('e7')], nextCursor: CURSOR, hasMore: true },
      { items: [event('e10')], nextCursor: 'ev2.CCCCCCCCCCCCCCCCCCCCCC', hasMore: false },
    ];
    const queries: Record<string, unknown>[] = [];
    const get = vi.fn(async (_p: string, schema: { parse: (v: unknown) => unknown }, opts) => {
      queries.push(opts?.query);
      return schema.parse(pages.shift());
    });
    const api = { orgId: 'sbx', get } as unknown as WorkbenchApi;
    const { result } = renderHook(() => useRecentEvents(api));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.items.map((e) => e.id)).toEqual(['e9', 'e8', 'e7']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(queries).toEqual([
      { orgId: 'sbx', limit: 5, order: 'desc', after: undefined },
      { orgId: 'sbx', limit: 50, order: undefined, after: CURSOR },
    ]);
    expect(result.current.items.map((e) => e.id)).toEqual(['e10', 'e9', 'e8', 'e7']);
  });
});

describe('Home time zone', () => {
  it("shows times in the context's zone", async () => {
    await renderApp('/workbench/o/sbx', {
      session: 'developer',
      handlers: homeHandlers(SANDBOX, [call('c1', 201)], 'Asia/Tokyo'),
    });
    const t = await screen.findAllByTitle(/Tokyo|JST|GMT\+9/);
    expect(t.length).toBeGreaterThan(0);
  });
});
