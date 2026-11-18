import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';

afterEach(() => {
  resetModeForTests();
  vi.unstubAllGlobals();
});

describe('pass list scan filter', () => {
  it('sends no scan in 30 days as the contract JSON, and the filter can be changed', async () => {
    const requests: URL[] = [];
    const user = userEvent.setup();
    const { router } = await renderApp('/admin/passes?noScanDays=30&orgId=o1', {
      session: 'user',
      memberships: [membershipFixture('o1')],
      handlers: {
        '/api/v1/passes': (url) => {
          requests.push(url);
          return json({ items: [], nextCursor: null });
        },
        '/api/v1/templates': () => json({ items: [], nextCursor: null }),
        '/api/v1/connections': () => json({ items: [], nextCursor: null }),
      },
    });
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(JSON.parse(requests[0]?.searchParams.get('scan') ?? 'null')).toEqual({ noScanDays: 30 });
    expect(requests[0]?.searchParams.has('noScanDays')).toBe(false);
    await user.click(await screen.findByRole('combobox', { name: /^Last scan/ }));
    await user.click(await screen.findByRole('option', { name: 'No scan in 90 days' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ noScanDays: 90 }));
    await waitFor(() =>
      expect(requests.some((u) => u.searchParams.get('scan') === '{"noScanDays":90}')).toBe(true),
    );
  });
});
