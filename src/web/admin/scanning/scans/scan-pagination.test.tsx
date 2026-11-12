import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests, setMode } from '@/web/lib/mode.ts';
import { json, membershipFixture, problem, renderApp } from '@/web/lib/test-utils.tsx';

const member = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const empty = () => json({ items: [], nextCursor: null });
const record = (id: string, passTitle: string) => ({
  id,
  at: 1_800_000_000_000,
  outcome: 'ok',
  reason: null,
  kind: 'check_in',
  actionId: null,
  actionLabel: 'Check in',
  direction: null,
  passId: 'pass-1',
  passTitle,
  templateId: null,
  templateName: null,
  eventId: null,
  eventName: null,
  scannerId: 's1',
  scannerName: 'Front door',
  staffId: null,
  staffName: null,
  approvedBy: null,
  method: 'manual',
  amount: null,
  before: null,
  after: null,
  passVersion: 1,
  override: false,
  offline: false,
  actor: { type: 'scanner', id: 's1' },
  undoneAt: null,
  undoneBy: null,
  undoes: null,
});
const handlers = {
  '/api/v1/scan-setups': empty,
  '/api/v1/scanning-sessions': empty,
  '/api/v1/scan-events': empty,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetModeForTests();
});

describe('scan history cursor pagination', () => {
  it.each(['7d', '30d'] as const)(
    'keeps the %s window fixed across rerenders, refresh and the next page',
    async (range) => {
      const now = new Date(2026, 10, 9, 12, 30, 15, 123).getTime();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      const requests: URL[] = [];
      const { queryClient } = await renderApp(`/admin/scanning?tab=scans&range=${range}&q=Anna`, {
        session: 'admin',
        memberships: [member],
        selectedOrg: 'o1',
        handlers: {
          ...handlers,
          '/api/v1/scans': (url) => {
            requests.push(url);
            return url.searchParams.get('cursor') === 'opaque-next'
              ? json({ items: [record('scan-2', 'Second')], nextCursor: null })
              : json({ items: [record('scan-1', 'First')], nextCursor: 'opaque-next' });
          },
        },
      });
      const row = (await screen.findByText('First')).closest('tr');
      expect(row).not.toBeNull();
      const start = new Date(now);
      start.setDate(start.getDate() - (range === '7d' ? 7 : 30));
      const expected = String(start.getTime());
      expect(requests[0]?.searchParams.get('from')).toBe(expected);

      clock.mockReturnValue(now + 60_000);
      const user = userEvent.setup();
      await user.click(within(row as HTMLElement).getByRole('button'));
      const sheet = await screen.findByRole('dialog', { name: 'Scan' });
      await user.click(within(sheet).getByRole('button', { name: 'Close' }));
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ['admin', 'scanning', 'scans'] });
      });
      expect(requests.every((url) => url.searchParams.get('from') === expected)).toBe(true);
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('Second')).toBeInTheDocument();
      const next = requests.find((url) => url.searchParams.get('cursor') === 'opaque-next');
      expect(next?.searchParams.get('from')).toBe(expected);
      expect(next?.searchParams.get('q')).toBe('Anna');
      expect(next?.searchParams.get('orgId')).toBe('o1');
    },
  );

  it('starts a fresh cursor window when a filter changes', async () => {
    const now = new Date(2026, 10, 9, 12, 30, 15, 123).getTime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const requests: URL[] = [];
    const { router } = await renderApp('/admin/scanning?tab=scans&range=7d', {
      session: 'admin',
      memberships: [member],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scans': (url) => {
          requests.push(url);
          return json({ items: [record('scan-1', 'First')], nextCursor: 'opaque-next' });
        },
      },
    });
    await screen.findByText('First');
    const first = requests[0]!.searchParams.get('from');
    clock.mockReturnValue(now + 3_600_000);
    await act(async () => {
      await router.navigate({
        to: '/admin/scanning',
        search: { orgId: 'o1', tab: 'scans', range: '30d' },
      });
    });
    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('from') !== first)).toBe(true),
    );
    const next = requests.find((url) => url.searchParams.get('from') !== first)!;
    const expected = new Date(now + 3_600_000);
    expected.setDate(expected.getDate() - 30);
    expect(next.searchParams.get('from')).toBe(String(expected.getTime()));
    expect(next.searchParams.has('cursor')).toBe(false);
    clock.mockReturnValue(now + 7_200_000);
    await act(async () => {
      await router.navigate({
        to: '/admin/scanning',
        search: { orgId: 'o1', tab: 'scans', range: '30d', q: 'Bob' },
      });
    });
    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('q') === 'Bob')).toBe(true),
    );
    const searched = requests.find((url) => url.searchParams.get('q') === 'Bob')!;
    const searchStart = new Date(now + 7_200_000);
    searchStart.setDate(searchStart.getDate() - 30);
    expect(searched.searchParams.get('from')).toBe(String(searchStart.getTime()));
    expect(searched.searchParams.has('cursor')).toBe(false);
  });

  it('starts a new window for a different organization or mode', async () => {
    const now = new Date(2026, 10, 9, 12, 30, 15, 123).getTime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const requests: { url: URL; mode: string }[] = [];
    const { router } = await renderApp('/admin/scanning?tab=scans&range=7d', {
      session: 'admin',
      memberships: [member, membershipFixture('o2', { orgName: 'Harbor' })],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scans': (url, init) => {
          requests.push({ url, mode: new Headers(init?.headers).get('x-passbook-mode') ?? 'live' });
          return json({ items: [record('scan-1', 'First')], nextCursor: 'opaque-next' });
        },
      },
    });
    await screen.findByText('First');
    clock.mockReturnValue(now + 3_600_000);
    await act(async () => {
      await router.navigate({
        to: '/admin/scanning',
        search: { orgId: 'o2', tab: 'scans', range: '7d' },
      });
    });
    const orgStart = new Date(now + 3_600_000);
    orgStart.setDate(orgStart.getDate() - 7);
    await waitFor(() =>
      expect(
        requests.some(
          ({ url }) =>
            url.searchParams.get('orgId') === 'o2' &&
            url.searchParams.get('from') === String(orgStart.getTime()) &&
            !url.searchParams.has('cursor'),
        ),
      ).toBe(true),
    );
    clock.mockReturnValue(now + 7_200_000);
    act(() => setMode('test'));
    const modeStart = new Date(now + 7_200_000);
    modeStart.setDate(modeStart.getDate() - 7);
    await waitFor(() =>
      expect(
        requests.some(
          ({ url, mode }) =>
            mode === 'test' &&
            url.searchParams.get('orgId') === 'o2' &&
            url.searchParams.get('from') === String(modeStart.getTime()) &&
            !url.searchParams.has('cursor'),
        ),
      ).toBe(true),
    );
  });

  it('keeps Load more available through empty pages without displaying opaque cursors', async () => {
    const now = new Date(2026, 10, 9, 12, 30, 15, 123).getTime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const requests: URL[] = [];
    await renderApp('/admin/scanning?tab=scans&range=7d', {
      session: 'admin',
      memberships: [member],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scans': (url) => {
          requests.push(url);
          const cursor = url.searchParams.get('cursor');
          if (cursor === 'opaque-two') {
            return json({ items: [record('scan-3', 'Visible scan')], nextCursor: null });
          }
          return json({ items: [], nextCursor: cursor ? 'opaque-two' : 'opaque-one' });
        },
      },
    });
    expect(await screen.findByText('No visible scans yet')).toBeInTheDocument();
    const user = userEvent.setup();
    clock.mockReturnValue(now + 1_000);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('cursor') === 'opaque-one')).toBe(true),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());
    expect(screen.getByText('No visible scans yet')).toBeInTheDocument();
    clock.mockReturnValue(now + 2_000);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Visible scan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    const from = requests[0]!.searchParams.get('from');
    expect(requests.every((url) => url.searchParams.get('from') === from)).toBe(true);
    expect(screen.queryByText('opaque-one')).not.toBeInTheDocument();
    expect(screen.queryByText('opaque-two')).not.toBeInTheDocument();
  });

  it('keeps the empty-page continuation available when loading another page fails', async () => {
    let attempts = 0;
    await renderApp('/admin/scanning?tab=scans&range=7d', {
      session: 'admin',
      memberships: [member],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scans': (url) => {
          if (!url.searchParams.has('cursor')) return json({ items: [], nextCursor: 'opaque-one' });
          attempts += 1;
          return attempts === 1
            ? problem(400, 'cursor_error', 'Could not load more.')
            : json({ items: [record('scan-2', 'Recovered scan')], nextCursor: null });
        },
      },
    });
    expect(await screen.findByText('No visible scans yet')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered scan')).toBeInTheDocument();
  });

  it('starts a new Today window at local midnight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = new Date(2026, 10, 9, 23, 59, 50, 0).getTime();
    vi.setSystemTime(now);
    const requests: URL[] = [];
    await renderApp('/admin/scanning?tab=scans', {
      session: 'admin',
      memberships: [member],
      selectedOrg: 'o1',
      handlers: {
        ...handlers,
        '/api/v1/scans': (url) => {
          requests.push(url);
          return json({ items: [record('scan-1', 'First')], nextCursor: 'opaque-next' });
        },
      },
    });
    await screen.findByText('First');
    const before = new Date(now);
    before.setHours(0, 0, 0, 0);
    expect(requests[0]?.searchParams.get('from')).toBe(String(before.getTime()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    const after = new Date(now + 11_000);
    after.setHours(0, 0, 0, 0);
    await waitFor(() =>
      expect(requests.some((url) => url.searchParams.get('from') === String(after.getTime()))).toBe(
        true,
      ),
    );
    const nextDay = requests.find(
      (url) => url.searchParams.get('from') === String(after.getTime()),
    );
    expect(nextDay?.searchParams.has('cursor')).toBe(false);
  });
});
