import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetModeForTests } from '@/web/lib/mode.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { templateFixture } from '../test-fixtures.ts';

const member = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const empty = () => json({ items: [], nextCursor: null });

afterEach(() => {
  vi.unstubAllGlobals();
  resetModeForTests();
});

describe('scan history, filtered by pass type', () => {
  it('sends the pass type the person picks and keeps it in the address', async () => {
    const requests: URL[] = [];
    const { router } = await renderApp('/admin/scanning?tab=scans', {
      session: 'admin',
      memberships: [member],
      selectedOrg: 'o1',
      handlers: {
        '/api/v1/scan-setups': empty,
        '/api/v1/scanning-sessions': empty,
        '/api/v1/scan-events': empty,
        '/api/v1/templates': () =>
          json({
            items: [
              templateFixture({ id: 't1', name: 'Day pass' }),
              templateFixture({ id: 't2', name: 'Monthly' }),
            ],
            nextCursor: null,
          }),
        '/api/v1/scans': (url) => {
          requests.push(url);
          return empty();
        },
      },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Pass type' }));
    await user.click(await screen.findByRole('option', { name: 'Day pass' }));
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('templateId')).toBe('t1'));
    expect(requests[0]?.searchParams.has('templateId')).toBe(false);
    expect(router.state.location.search).toMatchObject({ templateId: 't1' });
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('templateId'));
    expect(
      within(screen.getByRole('combobox', { name: 'Pass type' })).getByText('All pass types'),
    ).toBeInTheDocument();
  });
});
