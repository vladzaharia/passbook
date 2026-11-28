import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolScopeProvider } from '../../lib/tool-api.tsx';
import { refusingApi } from '../host/refusing.ts';
import { codeOf } from './curl.ts';
import { LogsTool } from './logs-tool.tsx';

const hosted = vi.hoisted(() => ({ kind: 'org' as 'org' | 'sandbox', admin: false }));
vi.mock('../host/tool-host.tsx', async (orig) => ({
  ...(await orig<typeof import('../host/tool-host.tsx')>()),
  useOptionalToolHost: () => ({ context: { orgId: 'nw', kind: hosted.kind } }),
}));
vi.mock('../../lib/session.ts', () => ({
  useMemberships: () => ({
    data: {
      items: [{ orgId: 'nw', capabilities: hosted.admin ? ['org:manage'] : ['org:read'] }],
    },
  }),
}));

import { detail, entry, page, reset, Scoped, stubApi, wideWindow } from './test-support.tsx';

beforeEach(() => {
  reset();
  wideWindow();
  hosted.kind = 'org';
  hosted.admin = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const open = () =>
  render(
    <Scoped>
      <LogsTool />
    </Scoped>,
  );
const rows = () => {
  const box = screen.queryByRole('listbox', { name: 'Requests' });
  return box ? within(box).queryAllByRole('option') : [];
};
const logCalls = (calls: string[]) => calls.filter((c) => /\/api\/v1\/request-logs\?/.test(c));
const param = (url: string, name: string) => new URL(url, 'http://x').searchParams.get(name);

describe('Logs before the token host is ready', () => {
  it('stays loading on the refusing client instead of failing the first read for good', async () => {
    stubApi({ lists: [page([entry(1)])] });
    render(
      <ToolScopeProvider api={refusingApi as never} client="workbench:none" mode="test" orgId="nw">
        <LogsTool />
      </ToolScopeProvider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(screen.queryByRole('region', { name: 'Did not load' })).toBeNull();
  });
});

describe('Logs on the Workbench token', () => {
  it('lists the org requests in one listbox, with the count once', async () => {
    stubApi({ lists: [page([entry(1), entry(2, { status: 404, code: 'NOT_FOUND' })])] });
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getAllByText('2 requests')).toHaveLength(1);
    expect(within(rows()[1] as HTMLElement).getByText('NOT_FOUND')).toBeInTheDocument();
    expect(screen.queryByText(/Kept 7 days/)).toBeNull();
    // Time is the org's zone (Pacific by default), not UTC: 22:15:52 UTC is 14:15:52 PST.
    expect(within(rows()[0] as HTMLElement).getByText(/14:15/)).toBeInTheDocument();
  });

  it('sends every read with the bearer and none with a mode header', async () => {
    const calls = stubApi({ lists: [page([entry(1)])], rows: { 'log-1': detail(1) } });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    await screen.findByRole('complementary', { name: 'Requests' });
    await waitFor(() => expect(calls.some((c) => c.includes('/captures?'))).toBe(true));
    const api = calls.filter((c) => c.startsWith('/api/v1/'));
    expect(api.length).toBeGreaterThan(3);
    api.forEach((c) => {
      expect(calls.auths[calls.indexOf(c)], c).toBe('Bearer pbtry_nw');
    });
  });

  it('hides the portal reads by default and sends the filters from the address', async () => {
    history.replaceState(
      null,
      '',
      '/workbench/o/nw/logs?status=4xx&key=key-9&pass=p-1&version=2026-11-01&path=pass&method=NOPE',
    );
    const calls = stubApi({ lists: [page([entry(1)])] });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const q = new URL(logCalls(calls)[0] as string, 'http://x').searchParams;
    expect(Object.fromEntries(q)).toEqual({
      status: '4xx',
      keyId: 'key-9',
      passId: 'p-1',
      version: '2026-11-01',
      path: 'pass',
      portal: 'hide',
    });
  });

  it('filters after a short pause and keeps the filter in the address', async () => {
    const calls = stubApi({ lists: [page([entry(1)]), page([entry(2)])] });
    open();
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

  it('names the keys in the Key filter and filters by one', async () => {
    const calls = stubApi({ lists: [page([entry(1)]), page([entry(2)])] });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const key = screen.getByLabelText('Key') as HTMLSelectElement;
    await waitFor(() =>
      expect(within(key).getByRole('option', { name: 'Sandbox key pb_test_ab12…' })).toBeTruthy(),
    );
    // A Live key is never offered: the Workbench is Test.
    expect(within(key).queryByRole('option', { name: /Live key/ })).toBeNull();
    fireEvent.change(key, { target: { value: 'key-12345678-xyz' } });
    await waitFor(() => expect(logCalls(calls)).toHaveLength(2));
    expect(param(logCalls(calls)[1] as string, 'keyId')).toBe('key-12345678-xyz');
  });

  it('filters by the version a call pinned', async () => {
    const calls = stubApi({
      lists: [page([entry(1, { apiVersion: '2026-11-01' })]), page([entry(2)])],
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(logCalls(calls)).toHaveLength(2));
    expect(param(logCalls(calls)[1] as string, 'version')).toBe('2026-11-01');
  });

  it('shows a pass filter from the address as a chip that clears it', async () => {
    history.replaceState(null, '', '/workbench/o/nw/logs?pass=pass-0001-abcdef');
    const calls = stubApi({ lists: [page([entry(1)]), page([entry(2)])] });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(param(logCalls(calls)[0] as string, 'passId')).toBe('pass-0001-abcdef');
    fireEvent.click(screen.getByRole('button', { name: /Clear pass filter/ }));
    await waitFor(() => expect(logCalls(calls)).toHaveLength(2));
    expect(param(logCalls(calls)[1] as string, 'passId')).toBeNull();
    expect(location.search).toBe('');
  });

  it('reads the Errors tab as 4xx and 5xx, newest first, and pages both', async () => {
    history.replaceState(null, '', '/workbench/o/nw/logs?tab=errors');
    const calls = stubApi({
      lists: [
        page([entry(1, { status: 404 })], { nextCursor: 'c4' }),
        page([entry(2, { status: 500 })]),
        page([entry(5, { status: 404 })]),
      ],
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(
      logCalls(calls)
        .slice(0, 2)
        .map((c) => param(c, 'status'))
        .sort(),
    ).toEqual(['4xx', '5xx']);
    expect(screen.getByRole('tab', { name: 'Errors' })).toHaveAttribute('aria-selected', 'true');
    // 5xx is the newer of the two.
    expect(rows()[0]?.id).toContain('req-1');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    // Only the stream that had more is asked again.
    const more = logCalls(calls).slice(2);
    expect(more).toHaveLength(1);
    expect(param(more[0] as string, 'status')).toBe('4xx');
    expect(param(more[0] as string, 'cursor')).toBe('c4');
  });

  it('switches to Errors from the tab and back, keeping the address in step', async () => {
    stubApi({ lists: [page([entry(1)])] });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole('tab', { name: 'Errors' }));
    expect(location.search).toBe('?tab=errors');
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(location.search).toBe('');
  });

  it('keeps the Errors view when the filters are cleared, and does not count it as a filter', async () => {
    history.replaceState(null, '', '/workbench/o/nw/logs?tab=errors&status=5xx');
    stubApi({ lists: [page([entry(1, { status: 500 })]), page([entry(2, { status: 500 })])] });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    expect(location.search).toBe('?tab=errors');
  });

  it('says there are no errors on an empty Errors tab', async () => {
    history.replaceState(null, '', '/workbench/o/nw/logs?tab=errors');
    stubApi({ lists: [page([])] });
    open();
    expect(await screen.findByText('No errors')).toBeInTheDocument();
  });

  it('moves an old #code= link into the query', async () => {
    const { migrateHash } = await import('./model.ts');
    history.replaceState(null, '', '/workbench/o/nw/logs#code=INVALID_BODY');
    migrateHash();
    expect(location.search).toBe('?code=INVALID_BODY');
    expect(location.hash).toBe('');
  });

  it('shows the client chip in the row and the inspector', async () => {
    stubApi({ lists: [page([entry(1, { client: 'curl/8.7.1' })])], rows: { 'log-1': detail(1) } });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0] as HTMLElement).getByText('curl/8.7.1')).toBeInTheDocument();
    fireEvent.click(rows()[0] as HTMLElement);
    const pane = await screen.findByRole('complementary', { name: 'Requests' });
    expect(within(pane).getByText('curl/8.7.1')).toBeInTheDocument();
  });

  it('opens a row in the inspector: tabs, Open in Console by request id, and the Trace', async () => {
    stubApi({ lists: [page([entry(1)])], rows: { 'log-1': detail(1) } });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    const pane = await screen.findByRole('complementary', { name: 'Requests' });
    expect(within(pane).getByRole('heading', { name: /POST \/passes\/p1\?a=1/ })).toBeVisible();
    expect(location.hash).toBe('#req-1');
    await waitFor(() => expect(within(pane).getByText(/Ada/)).toBeInTheDocument());
    const link = await within(pane).findByRole('link', { name: 'Open in Console' });
    // The id of the call, never its body: nothing of the body is in the address.
    expect(link.getAttribute('href')).toBe('/workbench/o/nw/console?op=passes.update&from=req-1');
    fireEvent.click(within(pane).getByRole('tab', { name: 'Response' }));
    expect(within(pane).getByText(/"ok"/)).toBeInTheDocument();
    const trace = within(pane).getByRole('navigation', { name: 'Trace' });
    expect(within(trace).getByText(/Sandbox key/)).toBeInTheDocument();
    await waitFor(() => expect(within(trace).getByText('pass.issued')).toBeInTheDocument());
  });

  it('lists the stored headers on the Headers tab, and the curl keeps them without a secret', async () => {
    stubApi({
      lists: [page([entry(1)])],
      rows: {
        'log-1': detail(1, {
          headers: {
            req: {
              'content-type': 'application/json',
              'idempotency-key': 'idem-1',
              'content-length': '9',
            },
            res: { etag: '"v2"' },
          },
        }),
      },
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    const pane = await screen.findByRole('complementary', { name: 'Requests' });
    fireEvent.click(await within(pane).findByRole('tab', { name: 'Headers' }));
    expect(within(pane).getByText('idempotency-key')).toBeInTheDocument();
    expect(within(pane).getByText('idem-1')).toBeInTheDocument();
    expect(within(pane).getByText('"v2"')).toBeInTheDocument();
    const text = codeOf(
      'curl',
      detail(1, {
        headers: {
          req: {
            'idempotency-key': 'idem-1',
            'if-match': '"v1"',
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': '9',
          },
          res: {},
        },
      }),
      'https://x.test',
    );
    expect(text).toContain('Authorization: Bearer $PASSBOOK_KEY');
    expect(text).toContain("'accept: application/json'");
    expect(text).not.toContain('idempotency-key');
    expect(text).not.toContain('if-match');
    const sneaky = detail(1, {
      headers: { req: { authorization: 'Bearer SECRET-TOKEN' }, res: {} },
    });
    expect(codeOf('curl', sneaky, 'https://x.test')).not.toContain('SECRET-TOKEN');
    expect(text).not.toContain('content-length');
  });

  it('says No headers recorded on an older row', async () => {
    stubApi({ lists: [page([entry(1)])], rows: { 'log-1': detail(1) } });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    const pane = await screen.findByRole('complementary', { name: 'Requests' });
    fireEvent.click(await within(pane).findByRole('tab', { name: 'Headers' }));
    expect(within(pane).getByText('No headers recorded')).toBeInTheDocument();
  });

  it('says the body is gone once it has expired', async () => {
    stubApi({
      lists: [page([entry(1, { hasBodies: false })])],
      rows: { 'log-1': detail(1, { hasBodies: false, requestBody: null, bodiesExpireAt: null }) },
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    expect(await screen.findByText('Body kept 24 h')).toBeInTheDocument();
  });

  it('says when a stored body was cut', async () => {
    stubApi({
      lists: [page([entry(1)])],
      rows: { 'log-1': detail(1, { bodiesTruncated: true }) },
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    expect(await screen.findByText('Cut at 8 KB')).toBeInTheDocument();
  });

  it('says Bodies off for this org, with no way to change it for a member', async () => {
    stubApi({
      lists: [page([entry(1, { hasBodies: false })])],
      rows: {
        'log-1': detail(1, {
          hasBodies: false,
          bodiesRecorded: false,
          requestBody: null,
          responseBody: null,
          bodiesExpireAt: null,
        }),
      },
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    expect(await screen.findByText('Bodies off for this org')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Turn on in admin' })).toBeNull();
  });

  it('shows an org admin where to turn bodies on', async () => {
    hosted.admin = true;
    stubApi({
      lists: [page([entry(1, { hasBodies: false })])],
      rows: {
        'log-1': detail(1, { hasBodies: false, bodiesRecorded: false, requestBody: null }),
      },
    });
    open();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0] as HTMLElement);
    const link = await screen.findByRole('link', { name: 'Turn on in admin' });
    expect(link.getAttribute('href')).toBe('/admin/o/nw/settings?mode=test');
  });

  it('opens a row by its request id in other letters, or by its log id, without pinning it', async () => {
    history.replaceState(null, '', '/workbench/o/nw/logs#REQ-2');
    stubApi({ lists: [page([entry(1), entry(2)])], rows: { 'log-2': detail(2) } });
    open();
    await waitFor(() => expect(location.hash).toBe('#req-2'));
    expect(screen.queryByText('Not in this view')).toBeNull();
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('pins a call older than the page, found by its log id', async () => {
    history.replaceState(null, '', '/workbench/o/nw/logs#log-9');
    stubApi({ lists: [page([entry(1)])], rows: { 'log-9': detail(9) } });
    open();
    await screen.findByText('Not in this view');
    await waitFor(() => expect(location.hash).toBe('#req-9'));
  });

  it('slides newer calls in at the top while listening, and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls = stubApi({ lists: [page([entry(2)]), page([entry(3)])] });
    open();
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
    open();
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
    open();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getAllByText('2+ requests').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(logCalls(calls).some((c) => c.includes('cursor=c2'))).toBe(true);
  });

  it('shows the first call and Run in Console when nothing is logged', async () => {
    stubApi({ lists: [page([])] });
    open();
    expect(await screen.findByText('Waiting for your first call')).toBeInTheDocument();
    expect(document.querySelector('.wl-buddy')?.getAttribute('data-scene')).toBe('listen');
    expect(screen.getByText(/PASSBOOK_KEY/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Run in Console' }).getAttribute('href')).toBe(
      '/workbench/o/nw/console',
    );
  });

  it('offers the way out when the filters match nothing', async () => {
    history.replaceState(null, '', '/workbench/o/nw/logs?status=5xx');
    const calls = stubApi({ lists: [page([]), page([entry(1)])] });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(location.search).toBe('');
    expect(logCalls(calls)[1]).not.toContain('status');
  });

  it('says it did not load, and Retry asks again', async () => {
    const calls = stubApi({ lists: [page([entry(1)])], status: 500 });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(logCalls(calls).length).toBeGreaterThan(1));
  });

  it('names a log that is full', async () => {
    stubApi({ lists: [page([entry(1)], { capped: 'hour' })] });
    open();
    expect(await screen.findByText(/full for this hour/)).toBeInTheDocument();
  });
});
