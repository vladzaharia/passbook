import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsTool } from './logs-tool.tsx';

vi.mock('../console/session.ts', async (orig) => ({
  ...(await orig<typeof import('../console/session.ts')>()),
  loadSession: async () => ({
    kind: 'ready',
    csrf: 'c',
    siteKey: '',
    sandbox: { id: 's', orgId: 'o', orgSlug: 'sbx', templateId: null },
  }),
}));
vi.mock('../console/token.ts', () => ({ token: async () => 'tok' }));

import { detail, entry, page, reset, stubApi, wideWindow } from './test-support.ts';

beforeEach(() => {
  reset();
  wideWindow();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const rows = () => {
  const box = screen.queryByRole('listbox', { name: 'Requests' });
  return box ? within(box).queryAllByRole('option') : [];
};
const logCalls = (calls: string[]) => calls.filter((c) => c.includes('/developer/logs?'));

describe('Logs on the bench', () => {
  it('lists requests in one listbox, with the count and the retention note', async () => {
    stubApi({ lists: [page([entry(1), entry(2, { status: 404, code: 'NOT_FOUND' })])] });
    render(<LogsTool />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole('listbox', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getAllByText('2 requests')).toHaveLength(2);
    expect(within(rows()[1] as HTMLElement).getByText('NOT_FOUND')).toBeInTheDocument();
    // In the toolbar from 1180 px, and again under the list below it (CSS shows one).
    expect(screen.getAllByText(/Kept 7 days/)).toHaveLength(2);
    // Time is the org's zone (Pacific by default), not UTC: 22:15:52 UTC is 14:15:52 PST.
    expect(within(rows()[0] as HTMLElement).getByText('14:15:52')).toBeInTheDocument();
  });

  it('reads Yours by default and sends the filters from the address', async () => {
    history.replaceState(null, '', '/developers/logs?status=4xx&key=key-9&path=pass&method=NOPE');
    const calls = stubApi({ lists: [page([entry(1)])] });
    render(<LogsTool />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    const q = new URL(logCalls(calls)[0] as string, 'http://x').searchParams;
    expect(Object.fromEntries(q)).toEqual({
      status: '4xx',
      keyId: 'key-9',
      path: 'pass',
      source: 'key',
    });
  });

  it('filters after a short pause and keeps the filter in the address', async () => {
    const calls = stubApi({ lists: [page([entry(1)]), page([entry(2)])] });
    render(<LogsTool />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search paths' }), {
      target: { value: 'passes' },
    });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: '5xx' } });
    await waitFor(() => expect(logCalls(calls)).toHaveLength(2));
    expect(logCalls(calls)[1]).toContain('status=5xx');
    expect(logCalls(calls)[1]).toContain('path=passes');
    expect(location.search).toContain('status=5xx');
    await waitFor(() => expect(rows()[0]?.id).toContain('req-2'));
  });

  it('moves an old #code= link into the query', async () => {
    const { migrateHash } = await import('./model.ts');
    history.replaceState(null, '', '/developers/logs#code=INVALID_BODY');
    migrateHash();
    expect(location.search).toBe('?code=INVALID_BODY');
    expect(location.hash).toBe('');
    history.replaceState(null, '', '/developers/logs#path=%2Fpasses');
    migrateHash();
    expect(location.search).toBe('?path=%2Fpasses');
  });

  it('opens a row in the inspector: Request and Response tabs, Run again, and the Trace', async () => {
    stubApi({ lists: [page([entry(1)])], rows: { 'log-1': detail(1) } });
    render(<LogsTool />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    const pane = await screen.findByRole('complementary', { name: 'Requests' });
    expect(within(pane).getByRole('heading', { name: /POST \/passes\/p1\?a=1/ })).toBeVisible();
    expect(location.hash).toBe('#req-1');
    await waitFor(() => expect(within(pane).getByText(/Ada/)).toBeInTheDocument());
    const again = within(pane).getByRole('link', { name: 'Run again' });
    expect(again.getAttribute('href')).toContain('#passes.update?body=');
    fireEvent.click(within(pane).getByRole('tab', { name: 'Response' }));
    expect(within(pane).getByText(/"ok"/)).toBeInTheDocument();
    const trace = within(pane).getByRole('navigation', { name: 'Trace' });
    expect(within(trace).getByText(/Sandbox key pb_test_ab12/)).toBeInTheDocument();
    await waitFor(() => expect(within(trace).getByText('pass.issued')).toBeInTheDocument());
  });

  it('says bodies are gone for a call older than a day', async () => {
    stubApi({
      lists: [page([entry(1, { hasBodies: false })])],
      rows: { 'log-1': detail(1, { hasBodies: false, requestBody: null, bodiesExpireAt: null }) },
    });
    render(<LogsTool />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    expect(await screen.findByText('Bodies are kept for 24 hours.')).toBeInTheDocument();
  });

  it('opens a row by its request id in other letters, or by its log id, without pinning it', async () => {
    history.replaceState(null, '', '/developers/logs#REQ-2');
    stubApi({ lists: [page([entry(1), entry(2)])], rows: { 'log-2': detail(2) } });
    render(<LogsTool />);
    await waitFor(() => expect(location.hash).toBe('#req-2'));
    expect(screen.queryByText('Not in this view')).toBeNull();
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('pins a call older than the page, found by its request id or by its log id', async () => {
    history.replaceState(null, '', '/developers/logs#log-9');
    stubApi({ lists: [page([entry(1)])], rows: { 'log-9': detail(9) } });
    render(<LogsTool />);
    await screen.findByText('Not in this view');
    await waitFor(() => expect(location.hash).toBe('#req-9'));
  });

  it('slides newer calls in at the top while listening, and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls = stubApi({ lists: [page([entry(2)]), page([entry(3)])] });
    render(<LogsTool />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(rows()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.id).toContain('req-3');
    expect(rows()[0]?.getAttribute('data-fresh')).not.toBeNull();
    expect(logCalls(calls).at(-1)).toContain('after=log-2');
    expect(screen.getByText('1 new request')).toBeInTheDocument();
    expect(screen.getByText('Listening')).toBeInTheDocument();
  });

  it('stops after ten quiet minutes and starts again on Resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const calls = stubApi({ lists: [page([entry(1)])] });
    render(<LogsTool />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4100);
    });
    expect(screen.getByText('Paused')).toBeInTheDocument();
    const before = logCalls(calls).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(logCalls(calls)).toHaveLength(before);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText('Listening')).toBeInTheDocument();
    expect(logCalls(calls).length).toBeGreaterThan(before);
  });

  it('pages by cursor and de-duplicates', async () => {
    const calls = stubApi({
      lists: [page([entry(1), entry(2)], { nextCursor: 'c2' }), page([entry(2), entry(3)])],
    });
    render(<LogsTool />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getAllByText('2+ requests').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(logCalls(calls).some((c) => c.includes('cursor=c2'))).toBe(true);
  });

  it('shows the first call with the key from the environment when nothing is logged', async () => {
    stubApi({ lists: [page([])] });
    render(<LogsTool />);
    expect(await screen.findByText('Waiting for your first call')).toBeInTheDocument();
    expect(screen.getByText(/PASSBOOK_KEY/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Run in console' })).toBeInTheDocument();
  });

  it('offers the way out when the filters match nothing', async () => {
    history.replaceState(null, '', '/developers/logs?status=5xx');
    const calls = stubApi({ lists: [page([]), page([entry(1)])] });
    render(<LogsTool />);
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(location.search).toBe('');
    expect(logCalls(calls)[1]).not.toContain('status');
  });

  it('shows the gate when the log is signed out, and no sandbox when it 404s', async () => {
    stubApi({ lists: [], status: 401 });
    const first = render(<LogsTool />);
    expect(await screen.findByText(/Sign in/)).toBeInTheDocument();
    first.unmount();
    stubApi({ lists: [], status: 404 });
    render(<LogsTool />);
    expect(await screen.findByText('No sandbox yet')).toBeInTheDocument();
  });

  it('says it did not load, and Retry asks again', async () => {
    const calls = stubApi({ lists: [page([entry(1)])], status: 500 });
    render(<LogsTool />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(logCalls(calls).length).toBeGreaterThan(1));
  });

  it('names a log that is full', async () => {
    stubApi({ lists: [page([entry(1)], { capped: 'hour' })] });
    render(<LogsTool />);
    expect(await screen.findByText(/full for this hour/)).toBeInTheDocument();
  });
});
