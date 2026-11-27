import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, renderApp } from '../../lib/test-utils.tsx';
import { fixtureOperation, SANDBOX_CREATE } from '../../ui/operation/fixtures.test-support.ts';
import { resetOperationCache } from '../../ui/operation/store.ts';
import type { Operation } from '../../ui/operation/types.ts';
import { forgetTokens } from '../host/token.ts';
import { handlers } from '../shell/test-fixtures.ts';

/** A wide window: the pane sits beside the list and a close is immediate. */
beforeEach(() => {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('1180') || q.includes('720') || q.includes('reduce'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetTokens();
  resetOperationCache();
  localStorage.clear();
  sessionStorage.clear();
  location.hash = '';
});

const op = (id: string, over: Partial<Operation>): Operation => ({
  ...fixtureOperation(SANDBOX_CREATE, { status: 'failed', id }),
  orgId: 'nw',
  mode: 'test',
  ...over,
});
const failed = op('op_failed', { title: 'Rebuild passes' });
const sticky = op('op_sticky', {
  title: 'Sync a connection',
  error: { code: 'X', message: 'Stopped.', step: null, retryable: false },
});
const live = op('op_live', { title: 'LIVE job', mode: 'live' });
const other = op('op_other', { title: 'Other org job', orgId: 'ac' });
const running = op('op_run', {
  ...fixtureOperation(SANDBOX_CREATE, { status: 'running', id: 'op_run' }),
  title: 'Create passes',
  orgId: 'nw',
  mode: 'test',
  cancelable: true,
});
const headersOf = (init: RequestInit | undefined) =>
  Object.fromEntries(new Headers(init?.headers).entries());
const paths = (fetchMock: { mock: { calls: unknown[][] } }) =>
  fetchMock.mock.calls.map(([url, init]) => ({
    path: new URL(String(url), 'http://localhost').pathname,
    init: init as RequestInit | undefined,
  }));

describe('the Workbench Activity tool', () => {
  it("lists this context's Test operations only, grouped, through the token", async () => {
    const { fetchMock } = await renderApp('/workbench/o/nw/activity', {
      session: 'developer',
      handlers: {
        ...handlers(),
        '/api/v1/operations': () => json({ items: [running, failed, sticky, live, other] }),
      },
    });
    const main = await screen.findByRole('region', { name: 'Running' });
    expect(within(main).getByText('Create passes')).toBeInTheDocument();
    expect(screen.getByText('Rebuild passes')).toBeInTheDocument();
    expect(screen.queryByText('LIVE job')).not.toBeInTheDocument();
    expect(screen.queryByText('Other org job')).not.toBeInTheDocument();
    for (const { init } of paths(fetchMock).filter((c) => c.path === '/api/v1/operations'))
      expect(headersOf(init).authorization).toBe('Bearer pbtry_nw');
  });

  it('says nothing is running when there are no operations', async () => {
    await renderApp('/workbench/o/nw/activity', {
      session: 'developer',
      handlers: handlers(),
    });
    expect(await screen.findByText('Nothing running')).toBeInTheDocument();
  });

  it('retries a failed operation with the token', async () => {
    let retried = 0;
    location.hash = '#op_failed';
    const { fetchMock } = await renderApp('/workbench/o/nw/activity', {
      session: 'developer',
      handlers: {
        ...handlers(),
        '/api/v1/operations': () => json({ items: [failed] }),
        '/api/v1/operations/op_failed/retry': () => {
          retried++;
          return json({ ...failed, status: 'queued', error: null, attempt: 2, revision: 4 });
        },
      },
    });
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    await waitFor(() => expect(retried).toBe(1));
    const [call] = paths(fetchMock).filter((c) => c.path.endsWith('/retry'));
    expect(headersOf(call?.init).authorization).toBe('Bearer pbtry_nw');
    expect(Object.keys(headersOf(call?.init)).some((h) => /mode/i.test(h))).toBe(false);
  });

  it('offers no Retry for a kind the token may not act on', async () => {
    location.hash = '#op_sticky';
    await renderApp('/workbench/o/nw/activity', {
      session: 'developer',
      handlers: { ...handlers(), '/api/v1/operations': () => json({ items: [sticky] }) },
    });
    await screen.findByRole('heading', { name: 'Sync a connection', level: 2 });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('stops a running operation with the token', async () => {
    let stopped = 0;
    location.hash = '#op_run';
    await renderApp('/workbench/o/nw/activity', {
      session: 'developer',
      handlers: {
        ...handlers(),
        '/api/v1/operations': () => json({ items: [running] }),
        '/api/v1/operations/op_run/cancel': () => {
          stopped++;
          return json({ ...running, cancelRequested: true, cancelable: false, revision: 4 });
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopped).toBe(1));
  });

  it('the tray links to All activity', async () => {
    const { router } = await renderApp('/workbench/o/nw/logs', {
      session: 'developer',
      handlers: { ...handlers(), '/api/v1/operations': () => json({ items: [running] }) },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Activity, 1 running' }));
    fireEvent.click(await screen.findByRole('button', { name: 'All activity' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/workbench/o/nw/activity'));
  });
});
