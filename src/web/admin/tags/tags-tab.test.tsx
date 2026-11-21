import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAG_COPY } from '@/shared/copy/tags.ts';
import { json, membershipFixture, renderApp } from '@/web/lib/test-utils.tsx';
import { AXE_MATRIX, axeAt, calls, page, personTag, tagFixture } from './test-fixtures.tsx';

const northwind = membershipFixture('o1', { orgName: 'Northwind', orgSlug: 'northwind' });
const empty = () => json({ items: [], nextCursor: null });
const lost = tagFixture({ id: 't3', label: 'Old fob', hint: '44C2', state: 'lost', binding: null });

function open(extra: Record<string, () => Response> = {}, query = '') {
  return renderApp(`/admin/scanning?tab=tags${query}`, {
    session: 'admin',
    memberships: [northwind],
    selectedOrg: 'o1',
    handlers: {
      '/api/v1/scanning-sessions': empty,
      '/api/v1/scan-setups': empty,
      '/api/v1/nfc/tags': () => page([tagFixture(), personTag(), lost]),
      '/api/v1/nfc/tags/t3': () => json(lost),
      '/api/v1/nfc/tags/t3/history': () =>
        json({
          nextCursor: null,
          events: [{ at: 1_800_000_200_000, action: 'lost', actorName: 'Ana R.' }],
          items: [
            {
              id: 'b9',
              tagId: 't3',
              scope: 'pass',
              passId: 'p1',
              passTitle: 'Gym pass',
              userId: null,
              holderName: null,
              source: 'scanner',
              lent: false,
              boundAt: 1_800_000_000_000,
              boundByName: 'Ana R.',
              scannerName: null,
              endedAt: 1_800_000_100_000,
              endCause: 'lost',
            },
          ],
        }),
      '/api/v1/nfc/tags/t3/restore': () => json(tagFixture({ id: 't3', label: 'Old fob' })),
      ...extra,
    },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('Tags tab', () => {
  it('lists the org tags with kind, holder and status', async () => {
    const { fetchMock } = await open();
    const table = await screen.findByRole('table', { name: 'Tags' });
    await within(table).findByText('Blue fob');
    expect(within(table).getByText('Key card')).toBeInTheDocument();
    expect(within(table).getByText('Old fob')).toBeInTheDocument();
    expect(within(table).getAllByText('Assigned').length).toBeGreaterThan(0);
    expect(within(table).getByText('Lost')).toBeInTheDocument();
    const [list] = calls(fetchMock, 'GET', '/nfc/tags');
    expect(new URL(String(list?.[0]), 'http://x').searchParams.get('orgId')).toBe('o1');
  });

  it('sends the status filter and shows the empty state', async () => {
    const { fetchMock } = await open({ '/api/v1/nfc/tags': () => page([]) });
    expect(await screen.findByText(TAG_COPY.inventory.empty.headline)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('filters by status through the URL', async () => {
    const { fetchMock } = await open({}, '&tagState=lost');
    await screen.findByRole('table', { name: 'Tags' });
    await waitFor(() => {
      const urls = calls(fetchMock, 'GET', '/nfc/tags').map(
        ([u]) => new URL(String(u), 'http://x'),
      );
      expect(urls.some((u) => u.searchParams.get('status') === 'lost')).toBe(true);
    });
  });

  it('opens a tag in the sheet and restores a lost one after a confirm', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await open();
    await user.click(await screen.findByRole('button', { name: /Old fob/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Old fob' });
    expect(await within(sheet).findByRole('list', { name: 'History' })).toBeInTheDocument();
    expect(within(sheet).getByRole('list', { name: 'History' })).toBeInTheDocument();
    expect(within(sheet).getByRole('list', { name: 'Changes' })).toHaveTextContent('by Ana R.');
    await user.click(within(sheet).getByRole('button', { name: TAG_COPY.menu.restore }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Restore Old fob?');
    await user.click(within(confirm).getByRole('button', { name: TAG_COPY.menu.restore }));
    await waitFor(() => expect(calls(fetchMock, 'POST', '/tags/t3/restore')).toHaveLength(1));
    expect(await screen.findByText('Old fob restored')).toBeInTheDocument();
  });

  it.each(AXE_MATRIX)(
    'has no axe violations at %i, %s',
    async (width, theme) => {
      open();
      const table = await screen.findByRole('table', { name: 'Tags' });
      await within(table).findByText('Blue fob');
      expect(await axeAt(document.body, width, theme)).toEqual([]);
    },
    15_000,
  );
});
